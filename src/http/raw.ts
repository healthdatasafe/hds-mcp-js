import { randomBytes } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildServer } from '../server.ts';
import { runWithCredentials, type RequestCredentials } from '../auth/session.ts';
import type { RequestedPermission } from '../auth/pryvAuth.ts';
import { isProdHost, platformOf } from '../lib/hostPolicy.ts';
import { safeLog } from '../lib/scrubber.ts';

/**
 * Raw mode (plan 118 RAW-MODE.md, perki 2026-11-04): for clients without the connector OAuth. The person adds only
 * the URL; `connect` returns the platform's sign-in link; once they accept, this MCP session holds an app access to
 * all their data (a master access `*` at manage; the platform masks genetics) that expires on its own at
 * the core. Stateful, in memory: a restart
 * signs everyone out. Fable review 2026-11-04 fixes: fixed platform, accepted access verified, one-time credential
 * hand-off, `expireAfter`, no re-bind, no sign-in or poll URL in logs, pending sessions capped apart.
 */

export const RAW_APP_ID = 'hds-mcp-raw';
// One consent line instead of one per root (perki 2026-11-05). The platform masks explicit-grant-only roots
// (genetics) under `*`; perki: follow the platform.
const MASTER: RequestedPermission[] = [{ streamId: '*', level: 'manage' }];
const PENDING_TTL_MS = 10 * 60_000;
const IDLE_MS = 30 * 60_000;
const LIFETIME_MS = 4 * 3600_000;
const PENDING_CAP = 100;
const CONNECTED_CAP = 500;
const TIMEOUT_MS = 10_000;

export interface RawConfig {
  /** Fixed platform (never from a tool argument). */
  serviceInfoUrl: string;
  allowedHosts: string[];
  fetchFn?: typeof fetch;
  /** For tests; deployments ask for the master access `*` at manage. */
  permissions?: () => Promise<RequestedPermission[]>;
}

// deviceName: one per session, so two sessions of one person never share (and cut) one access.
interface Pending { pollUrl: string; authUrl: string; permissions: RequestedPermission[]; deviceName: string; until: number }
interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  created: number;
  lastSeen: number;
  pending?: Pending;
  credentials?: RequestCredentials;
  accessId?: string;
  username?: string;
  /** Outcome of the last sign-in poll, kept for connect_status after the automatic poll consumed it. */
  outcome?: string;
  /** The poll in flight: concurrent requests share it (the credential hand-off is one-time). */
  polling?: Promise<string>;
}

// Before connect: tools that need the account refuse (session.ts throws on an empty endpoint).
const notConnected = (serviceInfoUrl: string): RequestCredentials => ({ apiEndpoint: '', serviceInfoUrl, prodWritesEnabled: false });

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export function rawMode (cfg: RawConfig) {
  const sessions = new Map<string, Session>();
  const doFetch = cfg.fetchFn ?? fetch;
  const call = (url: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS) =>
    doFetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });

  const connectedCount = () => [...sessions.values()].filter((s) => s.credentials).length;

  /** Deletes an access with its own token; false when the core refused or did not answer. */
  async function deleteAccess (apiEndpoint: string, accessId: string, timeoutMs?: number): Promise<boolean> {
    const api = new URL(apiEndpoint);
    const token = decodeURIComponent(api.username);
    api.username = '';
    try {
      const r = await call(`${api.href}accesses/${encodeURIComponent(accessId)}`, { method: 'DELETE', headers: { authorization: token } }, timeoutMs);
      if (!r.ok) safeLog(`raw: access revoke refused: HTTP ${r.status}`);
      return r.ok;
    } catch (err) {
      safeLog(`raw: access revoke failed: ${(err as Error).message}`);
      return false;
    }
  }

  async function revoke (s: Session, timeoutMs?: number): Promise<boolean> {
    if (!s.credentials || !s.accessId) return true;
    return deleteAccess(s.credentials.apiEndpoint, s.accessId, timeoutMs);
  }

  async function drop (id: string, s: Session, timeoutMs?: number) {
    sessions.delete(id);
    await revoke(s, timeoutMs);
    s.transport.close().catch(() => {});
    s.server.close().catch(() => {});
  }

  /** Accepted credential: one-time retrieve, then checked to be exactly the access this session asked for. */
  async function adopt (s: Session, pending: Pending, body: any) {
    let apiEndpoint: string;
    if (body.handoff?.key) {
      const tokenless = new URL(body.apiEndpoint);
      const r = await call(`${tokenless.href}shared-secrets/retrieve`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: body.handoff.key })
      });
      if (!r.ok) throw new Error(`credential retrieve failed: HTTP ${r.status}`);
      const secret = (await r.json() as any).secret;
      const u = new URL(secret.apiEndpoint);
      u.username = secret.token;
      apiEndpoint = u.href;
    } else {
      // The core fell back to inline delivery (no secret could be made): the token sits in the endpoint or beside it.
      const u = new URL(body.apiEndpoint);
      if (!u.username && typeof body.token === 'string') u.username = body.token;
      apiEndpoint = u.href;
    }
    const api = new URL(apiEndpoint);
    if (api.protocol !== 'https:' || !api.username) throw new Error('sign-in returned an unusable API address');
    const token = decodeURIComponent(api.username);
    const bare = new URL(api.href);
    bare.username = '';
    const r = await call(`${bare.href}access-info`, { headers: { authorization: token } });
    if (!r.ok) throw new Error(`access check failed: HTTP ${r.status}`);
    const info = await r.json() as any;
    try {
      if (isProdHost(api.href)) throw new Error('The remote HDS MCP is not available for production accounts yet');
      const asked = new Map(pending.permissions.map((p) => [p.streamId, p.level]));
      // Feature permissions (e.g. selfRevoke) carry no streamId.
      const got: Array<{ streamId: string; level: string }> = (info.permissions ?? []).filter((p: any) => p.streamId != null);
      // Name what differs (stream ids and device names only, never a token) so a mismatch can be diagnosed.
      const gotMap = new Map(got.map((p) => [p.streamId, p.level]));
      const diffs = [
        info.type !== 'app' ? `type ${info.type}` : '',
        info.name !== RAW_APP_ID ? `name ${info.name}` : '',
        info.deviceName !== pending.deviceName ? `deviceName ${info.deviceName ?? 'absent'}` : '',
        ...[...asked].filter(([id, level]) => gotMap.get(id) !== level).map(([id, level]) => `${id}: asked ${level}, got ${gotMap.get(id) ?? 'none'}`),
        // The core adds its own masks (level none: `:_system:account:`, explicit-grant-only roots such as genetics)
        // and a read of the access's own audit stream; neither grants more than asked. Anything else is refused.
        ...got.filter((p) => !asked.has(p.streamId) && p.level !== 'none' &&
          !(p.streamId === `:_audit:access-${info.id}` && p.level === 'read'))
          .map((p) => `${p.streamId}: not asked, got ${p.level}`)
      ].filter(Boolean);
      if (diffs.length > 0) {
        throw new Error(`the accepted access is not the one this session asked for (${diffs.slice(0, 6).join('; ')})`);
      }
      // A manage access must end on its own: refuse one without the expiry this session asked for.
      if (typeof info.expires !== 'number' || info.expires > Date.now() / 1000 + LIFETIME_MS / 1000 + 60) {
        throw new Error('the accepted access has no expiry');
      }
    } catch (err) {
      // The token is about to be discarded: delete its access so nothing consented outlives this refusal.
      if (info.id) await deleteAccess(apiEndpoint, info.id);
      throw err;
    }
    s.credentials = { apiEndpoint, serviceInfoUrl: cfg.serviceInfoUrl, prodWritesEnabled: false };
    s.accessId = info.id;
    s.username = info.user?.username ?? body.username;
    if (s.pending === pending) s.pending = undefined;
  }

  /** One poll of a pending sign-in; returns a sentence for the model. */
  function pollOnce (s: Session): Promise<string> {
    s.polling ??= pollOutcome(s)
      .then((outcome) => { s.outcome = outcome; return outcome; })
      .finally(() => { s.polling = undefined; });
    return s.polling;
  }

  async function pollOutcome (s: Session): Promise<string> {
    // Snapshot: a disconnect during this poll clears s.pending, the poll still finishes on its own request.
    const pending = s.pending;
    if (!pending) return s.outcome ?? (s.credentials ? `Connected as ${s.username}.` : 'Not connected: call connect.');
    if (Date.now() > pending.until) {
      s.pending = undefined;
      return 'The sign-in link expired. Call connect again for a new one.';
    }
    const r = await call(pending.pollUrl);
    if (!r.ok) return 'Still waiting for the person to sign in and accept.';
    const body = await r.json() as any;
    if (body.status === 'NEED_SIGNIN') return 'Still waiting for the person to sign in and accept.';
    if (body.status === 'REFUSED') {
      s.pending = undefined;
      return 'The person refused the access. Nothing is connected.';
    }
    if (body.status === 'ACCEPTED') {
      try {
        await adopt(s, pending, body);
      } catch (err) {
        s.pending = undefined;
        safeLog(`raw: accepted access refused: ${(err as Error).message}`);
        return `Sign-in could not be used: ${(err as Error).message}. Nothing is connected; call connect to retry.`;
      }
      // The session was closed or swept while the sign-in completed: do not leave its access behind.
      const id = s.transport.sessionId;
      if (!id || sessions.get(id) !== s) {
        await revoke(s);
        s.credentials = undefined;
        return 'This session has ended; reconnect.';
      }
      return `Connected as ${s.username} on the HDS ${platformOf(s.credentials!.apiEndpoint)} platform. Tell the person ` +
        'this account name and platform so they can check it is the account they meant.';
    }
    return 'Still waiting for the person to sign in and accept.';
  }

  function rawTools (getSession: () => Session) {
    return (server: McpServer) => {
      server.tool(
        'connect',
        'Sign the person in to their Health Data Safe account. Returns a link: give it to them to open, sign in and accept. The access covers all their HDS data except genetic results (HDS keeps those for an explicit grant), with the right to add and change data, and ends on its own after 4 hours or when they disconnect. Then call connect_status. Before reading any record, tell them that what you read is sent to your model provider.',
        {},
        async () => {
          const s = getSession();
          if (s.credentials) return text(`Already connected as ${s.username}. Call disconnect first to use another account.`);
          if (s.pending && Date.now() < s.pending.until) return text(`A sign-in link is already waiting: ${s.pending.authUrl}`);
          if (connectedCount() >= CONNECTED_CAP) return text('Too many sessions right now; try again later.');
          const si = await call(cfg.serviceInfoUrl);
          if (!si.ok) throw new Error(`service info failed: HTTP ${si.status}`);
          const access: string | undefined = (await si.json() as any).access;
          if (!access) throw new Error('service info has no access URL');
          const permissions = cfg.permissions ? await cfg.permissions() : MASTER;
          const deviceName = `session-${randomBytes(6).toString('hex')}`;
          const r = await call(access, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestingAppId: RAW_APP_ID,
              deviceName,
              requestedPermissions: permissions,
              languageCode: 'en',
              returnURL: 'self',
              expireAfter: LIFETIME_MS / 1000,
              credentialHandoff: 'shared-secret'
            })
          });
          if (!r.ok) throw new Error(`sign-in request failed: HTTP ${r.status}`);
          const init = await r.json() as any;
          const authUrl: string | undefined = init.authUrl ?? init.url;
          if (init.status !== 'NEED_SIGNIN' || !authUrl?.startsWith('https://') ||
              typeof init.poll !== 'string' || new URL(init.poll).origin !== new URL(access).origin) {
            throw new Error('sign-in request returned an unexpected answer');
          }
          s.pending = { pollUrl: init.poll, authUrl, permissions, deviceName, until: Date.now() + PENDING_TTL_MS };
          s.outcome = undefined;
          return text(`Give the person this link to open, sign in to Health Data Safe and accept (valid 10 minutes):\n${authUrl}\n` +
            'Then call connect_status.');
        }
      );
      server.tool(
        'connect_status',
        'Check whether the person finished signing in after connect. Every other tool also checks it.',
        {},
        async () => text(await pollOnce(getSession()))
      );
      server.tool(
        'disconnect',
        'End this connection: the access to the person\'s HDS account is deleted at once.',
        {},
        async () => {
          const s = getSession();
          // A poll in flight may still adopt an access: let it finish so the answer is true.
          if (s.polling) await s.polling.catch(() => {});
          const wasConnected = Boolean(s.credentials);
          const deleted = await revoke(s);
          s.credentials = undefined;
          s.accessId = undefined;
          s.pending = undefined;
          s.outcome = undefined;
          if (!wasConnected) return text('Nothing was connected.');
          return text(deleted
            ? 'Disconnected; the access is deleted.'
            : 'Disconnected here, but the access could not be deleted at HDS: it ends on its own within 4 hours, or the ' +
              'person can revoke "hds-mcp-raw" in their account settings.');
        }
      );
    };
  }

  function newSession (): Session {
    const s = {} as Session;
    s.created = s.lastSeen = Date.now();
    s.server = buildServer({ http: true, extraTools: rawTools(() => s), platform: platformOf(cfg.serviceInfoUrl) });
    s.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomBytes(32).toString('base64url'),
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: cfg.allowedHosts,
      onsessioninitialized: (id) => { sessions.set(id, s); }
    });
    s.transport.onclose = () => {
      const id = s.transport.sessionId;
      if (id && sessions.get(id) === s) drop(id, s).catch(() => {});
    };
    return s;
  }

  async function handle (req: Request, res: Response) {
    if (Array.isArray(req.body)) {
      // JSON-RPC batches left MCP in 2025-06-18; refusing them keeps every call visible to the checks here.
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Batch requests are not supported' }, id: null });
      return;
    }
    const sid = req.get('mcp-session-id');
    let s = sid ? sessions.get(sid) : undefined;
    if (!s) {
      if (sid) {
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
        return;
      }
      if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Start with initialize' }, id: null });
        return;
      }
      if (sessions.size - connectedCount() >= PENDING_CAP) {
        // A flood of bare initializes must not lock real users out: evict the oldest idle session that neither
        // holds an access nor waits for a sign-in; refuse only when every one of them waits for a person.
        const idle = [...sessions].filter(([, x]) => !x.credentials && !x.pending).sort(([, a], [, b]) => a.lastSeen - b.lastSeen)[0];
        if (!idle) {
          res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many sessions, retry later' }, id: null });
          return;
        }
        await drop(idle[0], idle[1]);
      }
      s = newSession();
      await s.server.connect(s.transport);
    }
    s.lastSeen = Date.now();
    if (s.pending) await pollOnce(s).catch((err) => safeLog(`raw: poll failed: ${(err as Error).message}`));
    const session = s;
    await runWithCredentials(session.credentials ?? notConnected(cfg.serviceInfoUrl), () =>
      session.transport.handleRequest(req, res, req.body));
  }

  /** Drops expired sessions (and their accesses): pending after 10 min, connected after 30 min idle or 4 h. */
  async function sweep (now = Date.now()) {
    for (const [id, s] of sessions) {
      const expired = s.credentials
        ? now - s.lastSeen > IDLE_MS || now - s.created > LIFETIME_MS
        : now - s.lastSeen > PENDING_TTL_MS;
      if (expired) await drop(id, s);
    }
  }

  return {
    mount (app: express.Express, path: string) {
      app.post(path, express.json({ limit: '4mb' }), (req, res) => {
        handle(req, res).catch((err) => {
          safeLog(`raw MCP request failed: ${(err as Error).message}`);
          if (!res.headersSent) res.status(500).json({ error: 'internal error' });
        });
      });
      // Stateful sessions but JSON answers only: no standalone SSE stream (proxies cut idle streams at 60 s).
      app.get(path, (_req, res) => { res.status(405).set('Allow', 'POST, DELETE').end(); });
      app.delete(path, (req, res) => {
        handle(req, res).catch(() => { if (!res.headersSent) res.status(500).end(); });
      });
      setInterval(() => { sweep().catch(() => {}); }, 60_000).unref();
    },
    sweep,
    /** On shutdown: delete every access this process holds, within Docker's stop grace (3 s each, 6 s in all). */
    async closeAll () {
      const all = Promise.all([...sessions].map(([id, s]) => drop(id, s, 3000)));
      await Promise.race([all, new Promise((resolve) => setTimeout(resolve, 6000).unref())]);
    },
    sessionCount: () => sessions.size
  };
}
