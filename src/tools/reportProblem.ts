import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { version } from '../server.ts';
import { apiGet } from '../lib/apiCall.ts';
import { getApiEndpoint, getServiceInfoUrl, isConnected } from '../auth/session.ts';
import { scrubReport } from '../lib/scrubber.ts';
import { platformOf, SERVICE_INFO } from '../lib/hostPolicy.ts';

const NEW_ISSUE = 'https://github.com/healthdatasafe/site-agents/issues/new';
const MAX_URL = 6000;
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
/** A failure older than this is not the one being reported. */
const LAST_FAILURE_MAX_AGE_MS = 60 * 60 * 1000;
export const DRAFT_NOTE = 'A draft was prepared; nothing is published until the person reviews and sends it.';

export const reportProblemInput = {
  asked: z.string().min(3).max(300).describe('What the person asked you to do, in a sentence. No health data.'),
  happened: z.string().min(3).max(1200).describe(
    'What went wrong: the tool that failed and its error message as-is. Leave out the person\'s data, names, account name and links.'
  ),
  client: z.string().max(80).optional().describe('The AI client (e.g. "Claude.ai web", "ChatGPT", "Claude Code").'),
  step: z.enum(['connect', 'reading data', 'writing data', 'other']).optional()
};

type Input = { asked: string; happened: string; client?: string; step?: string };

/** The last tool call that failed in this MCP session (a tool name from the closed set, a core error id slug). */
export interface LastFailure { tool: string; errorId: string | null; at: number }

/** The HDS issue intake a local (stdio) MCP uses when `HDS_MCP_ISSUES_URL` is unset. */
export const STDIO_DEFAULT_ISSUES_URL = 'https://issues.hds.ngo';

/**
 * stdio only: point report_problem at the HDS intake unless `HDS_MCP_ISSUES_URL` is set. Set to an empty string, it
 * keeps the GitHub link. A local MCP carries no source key, so its reports arrive as anonymous.
 */
export function applyStdioIssuesDefault (env: NodeJS.ProcessEnv = process.env): void {
  if (env.HDS_MCP_ISSUES_URL === undefined) env.HDS_MCP_ISSUES_URL = STDIO_DEFAULT_ISSUES_URL;
}

/**
 * The issue intake (hds-issues-service) this MCP sends drafts to, from the environment; null without
 * `HDS_MCP_ISSUES_URL` (report_problem then gives the GitHub link). `key` / `keyId` sign the attestation; a key with no
 * id, a short key or a URL that is not https (http only on the loopback, for local runs) is a configuration error.
 */
export function issuesConfig (env: NodeJS.ProcessEnv = process.env): { base: URL; key: string | null; keyId: string | null } | null {
  const raw = env.HDS_MCP_ISSUES_URL?.trim();
  if (!raw) return null;
  const base = new URL(raw.endsWith('/') ? raw : raw + '/');
  const secure = base.protocol === 'https:' || (base.protocol === 'http:' && LOOPBACK.has(base.hostname));
  if (!secure || base.username || base.password || base.search || base.hash) {
    throw new Error('HDS_MCP_ISSUES_URL must be the https base URL of the issues service, with no credentials, query or fragment');
  }
  const key = env.HDS_MCP_ISSUES_KEY?.trim() || null;
  const keyId = env.HDS_MCP_ISSUES_KEY_ID?.trim() || null;
  if (key != null && key.length < 16) throw new Error('HDS_MCP_ISSUES_KEY must be at least 16 characters');
  if ((key == null) !== (keyId == null)) throw new Error('HDS_MCP_ISSUES_KEY and HDS_MCP_ISSUES_KEY_ID go together');
  return { base, key, keyId };
}

/** The connected account's name (`<username>.<platform domain>/` or `<host>/<username>/`), to keep it out of the report. */
function connectedUsername (): string | null {
  try {
    if (!isConnected()) return null;
    const url = new URL(getApiEndpoint());
    const labels = url.hostname.split('.');
    if (labels.length >= 4) return labels[0];
    return url.pathname.split('/').filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * hds-issues-service attestation (its docs/SERVICE-API.md): `b64url(claims) + "." + b64url(HMAC-SHA256(key,
 * b64url(claims)))`. The claims say only that an HDS session existed: no username, no token.
 */
export function attest (key: string, keyId: string, env: 'demo' | 'prod', now = Date.now()): string {
  return signClaims(key, { src: keyId, r: 'verified', env, iat: Math.floor(now / 1000) });
}

const USERNAME_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

/**
 * hds-issues-service signed username (`idt`, its docs/SERVICE-API.md): the same key, claims `{ src, u, env, iat }`. The
 * review page offers "add my HDS username" only with it and sends it only when ticked; `att` stays identity-free.
 */
export function identify (key: string, keyId: string, env: 'demo' | 'prod', username: string, now = Date.now()): string {
  return signClaims(key, { src: keyId, u: username, env, iat: Math.floor(now / 1000) });
}

function signClaims (key: string, claims: object): string {
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${encoded}.${createHmac('sha256', key).update(encoded).digest('base64url')}`;
}

/** The connected account's username as the core states it (`access-info`), or null when it cannot be read. */
async function attestedUsername (): Promise<string | null> {
  try {
    const u = (await apiGet('access-info'))?.user?.username;
    return typeof u === 'string' && USERNAME_RE.test(u) ? u : null;
  } catch {
    return null;
  }
}

/**
 * A problem report the person reviews before anything is filed: with `HDS_MCP_ISSUES_URL`, the HDS review page with the
 * draft in the URL fragment (never sent to a server until they press Send there); otherwise a prefilled "Agent
 * problem" issue link on site-agents. HDS files nothing itself. The counterpart of report_missing_item for problems with
 * the connector rather than gaps in the data model.
 */
export async function reportProblemHandler (
  input: Input,
  lastFailure: LastFailure | null = null
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const issues = issuesConfig();
  // Every free-text field: the draft goes to a report someone else reads (B-2026-11-09-10).
  const opts = { username: connectedUsername() };
  const asked = scrubReport(input.asked, opts);
  const happened = scrubReport(input.happened, opts);
  const client = input.client == null ? undefined : scrubReport(input.client, opts);
  const step = input.step;
  const failure = lastFailure != null && Date.now() - lastFailure.at <= LAST_FAILURE_MAX_AGE_MS ? lastFailure : null;
  const body = [
    '**What did you ask your agent to do?**', asked, '',
    '**What happened instead?**', happened, '',
    '**Setup**',
    `- AI client: ${client ?? '(not given)'}`,
    `- HDS MCP: ${version}`,
    `- Where it failed: ${step ?? 'other'}`,
    ...(failure != null ? [`- Last failed tool: ${failure.tool}`] : []),
    ...(failure?.errorId != null ? [`- Core error id: ${failure.errorId}`] : []),
    '',
    `_Prepared by the HDS MCP. Please check it holds no personal data before ${issues ? 'sending' : 'posting'}._`
  ].join('\n');
  const title = `MCP problem: ${asked.slice(0, 80)}`;

  if (issues != null) {
    const env = platformOf(getServiceInfoUrl() ?? SERVICE_INFO.demo) === 'production' ? 'prod' : 'demo';
    const { key, keyId } = issues;
    const signer = key != null && keyId != null && isConnected() ? { key, keyId } : null;
    const att = signer != null ? attest(signer.key, signer.keyId, env) : null;
    const username = signer != null ? await attestedUsername() : null;
    const idt = signer != null && username != null ? identify(signer.key, signer.keyId, env, username) : null;
    const signed = { ...(att != null ? { att } : {}), ...(idt != null ? { idt } : {}) };
    const draft = { v: 1, source: 'mcp', component: 'report_problem', version, env, title, body, ...signed };
    const href = new URL('new', issues.base).href + '#' + Buffer.from(JSON.stringify(draft), 'utf8').toString('base64url');
    if (href.length > MAX_URL) throw new Error('report too long: shorten what happened');
    return {
      content: [{
        type: 'text',
        text: 'Give the person this link. It opens the draft of a problem report for the HDS team, on an HDS page: they ' +
          'read it, change or remove anything, and send it from there (no account needed). ' + DRAFT_NOTE + '\n\n' + href
      }]
    };
  }

  const url = new URL(NEW_ISSUE);
  url.searchParams.set('template', 'agent-problem.md');
  url.searchParams.set('labels', 'agent-problem');
  url.searchParams.set('title', title);
  url.searchParams.set('body', body);
  if (url.href.length > MAX_URL) throw new Error('report too long: shorten what happened');
  return {
    content: [{
      type: 'text',
      text: 'Give the person this link. It opens a prefilled problem report on GitHub (a free GitHub account is needed, ' +
        'see https://agents.datasafe.dev/feedback); they read it and post it themselves. ' + DRAFT_NOTE + '\n\n' + url.href
    }]
  };
}
