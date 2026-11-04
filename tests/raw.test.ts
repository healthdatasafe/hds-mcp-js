import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { createHttpApp } from '../src/http/app.ts';
import { rawMode } from '../src/http/raw.ts';

const PERMS = [{ streamId: 'body', level: 'manage' as const, defaultName: 'Body' }];

// A fake platform behind fetchFn: service info, auth request + poll, one-time secret, access-info, access delete.
function platform (opts: { name?: string, expires?: number | null, deleteStatus?: number } = {}) {
  const state = { poll: 'NEED_SIGNIN', retrieved: 0, deleted: [] as string[], authBody: null as any };
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://reg.fake.test/service/info') return json({ access: 'https://reg.fake.test/access/' });
    if (url === 'https://reg.fake.test/access/') {
      state.authBody = JSON.parse(String(init?.body));
      return json({ status: 'NEED_SIGNIN', authUrl: 'https://account.fake.test/auth?key=k1', poll: 'https://reg.fake.test/access/k1' }, 201);
    }
    if (url === 'https://reg.fake.test/access/k1') {
      return json(state.poll === 'ACCEPTED'
        ? { status: 'ACCEPTED', username: 'alice', apiEndpoint: 'https://api.fake.test/alice/', handoff: { type: 'shared-secret', key: 's1' } }
        : { status: state.poll });
    }
    if (url === 'https://api.fake.test/alice/shared-secrets/retrieve') {
      state.retrieved++;
      return json({ secret: { username: 'alice', token: 'tok-alice', apiEndpoint: 'https://api.fake.test/alice/' } });
    }
    if (url === 'https://api.fake.test/alice/access-info') {
      assert.equal((init?.headers as Record<string, string>).authorization, 'tok-alice');
      const expires = opts.expires === undefined ? Math.floor(Date.now() / 1000) + 4 * 3600 : opts.expires;
      return json({ id: 'acc1', type: 'app', name: opts.name ?? 'hds-mcp-raw', deviceName: state.authBody.deviceName, ...(expires == null ? {} : { expires }), permissions: [...PERMS, { feature: 'selfRevoke', setting: 'allowed' }], user: { username: 'alice' } });
    }
    if (url === 'https://api.fake.test/alice/accesses/acc1' && init?.method === 'DELETE') {
      state.deleted.push('acc1');
      return json({ accessDeletion: { id: 'acc1' } }, opts.deleteStatus ?? 200);
    }
    return json({ error: `unexpected ${url}` }, 500);
  }) as typeof fetch;
  return { state, fetchFn };
}

async function start (opts: { name?: string, expires?: number | null, deleteStatus?: number } = {}) {
  const p = platform(opts);
  const allowedHosts: string[] = [];
  const raw = rawMode({ serviceInfoUrl: 'https://reg.fake.test/service/info', allowedHosts, fetchFn: p.fetchFn, permissions: async () => PERMS });
  const app = createHttpApp({
    publicUrl: new URL('http://127.0.0.1/adapter/mcp/mcp'),
    oauthMetadata: { issuer: 'https://issuer.test', authorization_endpoint: 'https://issuer.test/a', token_endpoint: 'https://issuer.test/t', response_types_supported: ['code'] },
    allowedOrigins: [],
    verifier: { async verifyAccessToken () { throw new InvalidTokenError('no'); } },
    raw
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  allowedHosts.push(host);
  const url = `http://${host}/adapter/mcp/raw`;
  let sid: string | null = null;
  let id = 0;
  const rpc = async (method: string, params: unknown = {}) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })
    });
    sid = res.headers.get('mcp-session-id') ?? sid;
    return { status: res.status, body: await res.json() as any };
  };
  const tool = async (name: string, args: unknown = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return r.body.result?.content?.[0]?.text as string;
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  return { p, raw, server, url, rpc, tool, sid: () => sid };
}

test('raw: sign in by link, verified access, tools run as the person, disconnect deletes the access', async () => {
  const t = await start();
  try {
    assert.ok(t.sid());
    const names = (await t.rpc('tools/list')).body.result.tools.map((x: any) => x.name);
    for (const n of ['connect', 'connect_status', 'disconnect', 'get_import_guide', 'report_missing_item']) assert.ok(names.includes(n), n);
    assert.match(await t.tool('get_events'), /Not connected/);

    const link = await t.tool('connect');
    assert.match(link, /https:\/\/account\.fake\.test\/auth\?key=k1/);
    assert.equal(t.p.state.authBody.requestingAppId, 'hds-mcp-raw');
    assert.equal(t.p.state.authBody.credentialHandoff, 'shared-secret');
    assert.equal(t.p.state.authBody.expireAfter, 4 * 3600);
    assert.deepEqual(t.p.state.authBody.requestedPermissions, PERMS);
    assert.match(await t.tool('connect_status'), /Still waiting/);

    t.p.state.poll = 'ACCEPTED';
    assert.match(await t.tool('connect_status'), /Connected as alice/);
    assert.equal(t.p.state.retrieved, 1);
    assert.match(await t.tool('connect'), /Already connected as alice/);

    assert.match(await t.tool('disconnect'), /access is deleted/);
    assert.deepEqual(t.p.state.deleted, ['acc1']);
    assert.match(await t.tool('get_events'), /Not connected/);
  } finally { t.server.close(); }
});

test('raw: an accepted access that is not the one asked for is refused (account substitution)', async () => {
  const t = await start({ name: 'someone-elses-app' });
  try {
    await t.tool('connect');
    t.p.state.poll = 'ACCEPTED';
    assert.match(await t.tool('connect_status'), /could not be used: the accepted access is not the one this session asked for/);
    assert.match(await t.tool('get_events'), /Not connected/);
  } finally { t.server.close(); }
});

test('raw: unknown session 404, no session and not initialize 400, GET 405; sweep revokes expired sessions', async () => {
  const t = await start();
  try {
    const post = (headers: Record<string, string>) => fetch(t.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    assert.equal((await post({ 'mcp-session-id': 'nope' })).status, 404);
    assert.equal((await post({})).status, 400);
    assert.equal((await fetch(t.url)).status, 405);

    await t.tool('connect');
    t.p.state.poll = 'ACCEPTED';
    await t.tool('connect_status');
    assert.equal(t.raw.sessionCount(), 1);
    await t.raw.sweep(Date.now() + 5 * 3600_000);
    assert.equal(t.raw.sessionCount(), 0);
    assert.deepEqual(t.p.state.deleted, ['acc1']);
  } finally { t.server.close(); }
});

test('raw: concurrent requests share one poll, the one-time secret is retrieved once', async () => {
  const t = await start();
  try {
    await t.tool('connect');
    t.p.state.poll = 'ACCEPTED';
    const [a, b] = await Promise.all([t.tool('connect_status'), t.tool('connect_status')]);
    assert.equal(t.p.state.retrieved, 1);
    assert.match(a, /Connected as alice/);
    assert.match(b, /Connected as alice/);
  } finally { t.server.close(); }
});

test('raw: an access without the asked expiry is refused and deleted; a refused sign-in says so', async () => {
  const t = await start({ expires: null });
  try {
    await t.tool('connect');
    assert.match(t.p.state.authBody.deviceName, /^session-[0-9a-f]{12}$/);
    t.p.state.poll = 'ACCEPTED';
    assert.match(await t.tool('connect_status'), /has no expiry/);
    assert.deepEqual(t.p.state.deleted, ['acc1']);
    t.p.state.poll = 'REFUSED';
    await t.tool('connect');
    assert.match(await t.tool('connect_status'), /refused the access/);
  } finally { t.server.close(); }
});

test('raw: disconnect tells the truth when the core refuses the delete; batches and foreign Hosts are refused', async () => {
  const t = await start({ deleteStatus: 403 });
  try {
    assert.match(await t.tool('disconnect'), /Nothing was connected/);
    await t.tool('connect');
    t.p.state.poll = 'ACCEPTED';
    await t.tool('connect_status');
    assert.match(await t.tool('disconnect'), /could not be deleted at HDS/);
    const batch = await fetch(t.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': t.sid()! },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])
    });
    assert.equal(batch.status, 400);
    const foreign = await new Promise<number>((resolve) => {
      const r = http.request(t.url, { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      r.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }));
    });
    assert.equal(foreign, 403);
  } finally { t.server.close(); }
});
