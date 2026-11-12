import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { applyStdioIssuesDefault, attest, identify, issuesConfig, reportProblemHandler, STDIO_DEFAULT_ISSUES_URL } from '../src/tools/reportProblem.ts';
import { runWithCredentials, setApiEndpoint, clearApiEndpoint } from '../src/auth/session.ts';
import { buildServer, version } from '../src/server.ts';

const KEY = 'test-key-at-least-16-chars';
const DEMO = { apiEndpoint: 'https://tok123@alice.demo.datasafe.dev/', serviceInfoUrl: 'https://demo.datasafe.dev/reg/service/info', prodWritesEnabled: false };
const PROD = { apiEndpoint: 'https://tok123@alice.api.datasafe.dev/', serviceInfoUrl: 'https://reg.api.datasafe.dev/service/info', prodWritesEnabled: true };
const NOT_CONNECTED = { apiEndpoint: '', serviceInfoUrl: 'https://demo.datasafe.dev/reg/service/info', prodWritesEnabled: false };
const INPUT = {
  asked: 'read alice weight',
  happened: 'get_events: Pryv events failed at https://tok123@alice.demo.datasafe.dev/events?auth=sekret ' +
    'with Authorization: tok123, Bearer eyJhbGciOiJIUzI1NiJ9.e30.x, token ckq3x9m2k0001abcdefghijk1, contact alice@example.com',
  client: 'Claude Code for alice',
  step: 'reading data' as const
};
const SECRETS = ['alice', 'example.com', 'ckq3x9m2k0001abcdefghijk1', 'eyJhbGciOiJIUzI1NiJ9', 'sekret', 'tok123'];

/**
 * hds-issues-service `src/lib/attestation.ts` `verify` (0.1.0), copied as-is minus its error types: the check the
 * intake runs on `att` at submit. The local journey (P2) ran the real one.
 */
function serviceVerify (att: string, keys: Record<string, { secret: string, env: 'demo' | 'prod' | null }>, now: number): { reporter: string, env: string } {
  const parts = att.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) throw new Error('att is malformed');
  const c = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  if (typeof c.src !== 'string' || (c.r !== 'verified' && c.r !== 'anonymous') || (c.env !== 'demo' && c.env !== 'prod')) throw new Error('att claims are malformed');
  if (typeof c.iat !== 'number' || !Number.isFinite(c.iat)) throw new Error('att claims are malformed');
  const key = Object.hasOwn(keys, c.src) ? keys[c.src] : undefined;
  if (key == null) throw new Error('att is signed by an unknown source');
  const expected = crypto.createHmac('sha256', key.secret).update(parts[0]).digest();
  const given = Buffer.from(parts[1], 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new Error('att signature does not verify');
  if (key.env != null && c.env !== key.env) throw new Error('att env contradicts the source key binding');
  if (now - c.iat > 48 * 3600 || c.iat - now > 300) return { reporter: 'anonymous', env: c.env };
  return { reporter: c.r, env: key.env ?? c.env };
}

/** hds-issues-service `verifyIdentity`'s signature and shape check (0.2.0): the claims of a signed username. */
function serviceIdentity (idt: string, secret: string): { src: string, u: string, env: string, iat: number } {
  const [enc, mac] = idt.split('.');
  const expected = crypto.createHmac('sha256', secret).update(enc).digest('base64url');
  if (mac !== expected) throw new Error('idt signature does not verify');
  const c = JSON.parse(Buffer.from(enc, 'base64url').toString('utf8'));
  if ('r' in c || typeof c.u !== 'string' || !/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(c.u)) throw new Error('idt claims are malformed');
  return c;
}

/** `access-info` as the core answers it for the connected account. */
function mockAccessInfo (t: { mock: { method: (o: object, m: string, f: () => unknown) => unknown } }, body: unknown, status = 200): void {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body), { status }));
}

function withEnv (t: { after: (fn: () => void) => void }, vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  t.after(() => { for (const k of Object.keys(vars)) delete process.env[k]; });
}

function linkOf (res: { content: Array<{ text: string }> }): { href: string, url: URL, draft: any } {
  const href = res.content[0].text.split('\n').pop()!;
  const url = new URL(href);
  return { href, url, draft: JSON.parse(Buffer.from(url.hash.slice(1), 'base64url').toString('utf8')) };
}

test('review link: the draft in the format the review page decodes, scrubbed, no identifier anywhere in the URL', async (t) => {
  withEnv(t, { HDS_MCP_ISSUES_URL: 'https://issues.example.test/' });
  const { href, url, draft } = linkOf(await runWithCredentials(DEMO, () => reportProblemHandler(INPUT)));
  assert.equal(url.origin + url.pathname, 'https://issues.example.test/new');
  assert.equal(url.search, '');
  assert.equal(draft.v, 1);
  assert.equal(draft.source, 'mcp');
  assert.equal(draft.component, 'report_problem');
  assert.equal(draft.version, version);
  assert.equal(draft.env, 'demo');
  assert.equal(typeof draft.title, 'string');
  assert.equal(typeof draft.body, 'string');
  assert.equal(draft.att, undefined, 'no key: no attestation');
  assert.equal(draft.title, 'MCP problem: read {username} weight');
  assert.match(draft.body, /failed at https:\/\/\*\*\*@\{username\}\.demo\.datasafe\.dev\/ with Authorization: \*\*\*/);
  const decoded = JSON.stringify(draft);
  for (const s of SECRETS) {
    assert.ok(!href.toLowerCase().includes(s.toLowerCase()), `link bytes hold ${s}`);
    assert.ok(!decoded.toLowerCase().includes(s.toLowerCase()), `draft holds ${s}`);
  }
  // Service caps (POST /issues): title ≤ 200, body ≤ 20 000; the version matches its pattern.
  assert.ok(draft.title.length <= 200 && draft.body.length <= 20000);
  assert.match(draft.version, /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/);
});

test('review link: attested when connected and keyed, verified by the intake\'s own check; claims carry no identifier', async (t) => {
  withEnv(t, { HDS_MCP_ISSUES_URL: 'https://issues.example.test', HDS_MCP_ISSUES_KEY: KEY, HDS_MCP_ISSUES_KEY_ID: 'hds-mcp-us1' });
  mockAccessInfo(t, { type: 'app', user: { username: 'alice' } });
  const now = Math.floor(Date.now() / 1000);
  const { draft } = linkOf(await runWithCredentials(PROD, () => reportProblemHandler(INPUT)));
  assert.equal(draft.env, 'prod');
  assert.equal(typeof draft.att, 'string');
  const claims = JSON.parse(Buffer.from(draft.att.split('.')[0], 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(claims).sort(), ['env', 'iat', 'r', 'src']);
  assert.equal(claims.src, 'hds-mcp-us1');
  assert.equal(claims.r, 'verified');
  for (const s of SECRETS) assert.ok(!draft.att.includes(s) && !JSON.stringify(claims).includes(s), `att holds ${s}`);
  assert.deepEqual(serviceVerify(draft.att, { 'hds-mcp-us1': { secret: KEY, env: 'prod' } }, now), { reporter: 'verified', env: 'prod' });
  assert.throws(() => serviceVerify(draft.att, { 'hds-mcp-us1': { secret: 'another-key-of-16-chars', env: 'prod' } }, now), /does not verify/);
  assert.throws(() => serviceVerify(draft.att, { 'hds-mcp-us1': { secret: KEY, env: 'demo' } }, now), /contradicts/);
  assert.equal(serviceVerify(attest(KEY, 'hds-mcp-us1', 'prod', (now - 49 * 3600) * 1000), { 'hds-mcp-us1': { secret: KEY, env: 'prod' } }, now).reporter, 'anonymous');
});

test('review link: the username is signed (idt) from access-info, beside an att that still names nobody', async (t) => {
  withEnv(t, { HDS_MCP_ISSUES_URL: 'https://issues.example.test', HDS_MCP_ISSUES_KEY: KEY, HDS_MCP_ISSUES_KEY_ID: 'hds-mcp-demo' });
  mockAccessInfo(t, { type: 'app', user: { username: 'testuser56' } });
  const { draft } = linkOf(await runWithCredentials(DEMO, () => reportProblemHandler(INPUT)));
  const claims = serviceIdentity(draft.idt, KEY);
  assert.deepEqual(Object.keys(claims).sort(), ['env', 'iat', 'src', 'u']);
  assert.equal(claims.u, 'testuser56');
  assert.equal(claims.src, 'hds-mcp-demo');
  assert.equal(claims.env, 'demo');
  assert.ok(!Buffer.from(draft.att.split('.')[0], 'base64url').toString('utf8').includes('testuser56'), 'att names nobody');
  assert.throws(() => serviceIdentity(draft.idt, 'another-key-of-16-chars'), /does not verify/);
  assert.throws(() => serviceIdentity(draft.att, KEY), /malformed/, 'an att is not an idt');
  assert.match(identify(KEY, 'hds-mcp-demo', 'demo', 'bob'), /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test('review link: no idt when the core does not answer, or answers no valid username (att unchanged)', async (t) => {
  withEnv(t, { HDS_MCP_ISSUES_URL: 'https://issues.example.test', HDS_MCP_ISSUES_KEY: KEY, HDS_MCP_ISSUES_KEY_ID: 'hds-mcp-demo' });
  for (const [body, status] of [[{ error: { id: 'invalid-access-token' } }, 401], [{ user: {} }, 200], [{ user: { username: 'Not_A_Name' } }, 200]] as const) {
    t.mock.restoreAll();
    mockAccessInfo(t, body, status);
    const { draft } = linkOf(await runWithCredentials(DEMO, () => reportProblemHandler(INPUT)));
    assert.equal(typeof draft.att, 'string', JSON.stringify(body));
    assert.equal(draft.idt, undefined, JSON.stringify(body));
  }
});

test('review link: anonymous (no att, no idt) when nobody is connected, over HTTP and over stdio', async (t) => {
  withEnv(t, { HDS_MCP_ISSUES_URL: 'https://issues.example.test', HDS_MCP_ISSUES_KEY: KEY, HDS_MCP_ISSUES_KEY_ID: 'hds-mcp-demo' });
  const http = linkOf(await runWithCredentials(NOT_CONNECTED, () => reportProblemHandler(INPUT))).draft;
  assert.equal(http.att, undefined);
  assert.equal(http.idt, undefined);
  assert.equal(http.env, 'demo');
  const stdio = linkOf(await reportProblemHandler(INPUT)).draft;
  assert.equal(stdio.att, undefined);
  assert.equal(stdio.idt, undefined);
  assert.equal(stdio.env, 'demo');
});

test('review link: the URL cap still applies', async (t) => {
  withEnv(t, { HDS_MCP_ISSUES_URL: 'https://issues.example.test' });
  // Characters that grow 4/3 in base64url and 6x in JSON escapes: well over 6000 characters.
  await assert.rejects(reportProblemHandler({ asked: 'x'.repeat(300), happened: '\u0001'.repeat(1200) }), /report too long/);
});

test('issuesConfig: unset is the GitHub link; bad values refuse to start', () => {
  assert.equal(issuesConfig({}), null);
  assert.equal(issuesConfig({ HDS_MCP_ISSUES_URL: 'http://127.0.0.1:6060' })!.base.href, 'http://127.0.0.1:6060/');
  assert.throws(() => issuesConfig({ HDS_MCP_ISSUES_URL: 'http://issues.example.test' }), /https base URL/);
  assert.throws(() => issuesConfig({ HDS_MCP_ISSUES_URL: 'https://u:p@issues.example.test' }), /no credentials/);
  assert.throws(() => issuesConfig({ HDS_MCP_ISSUES_URL: 'https://issues.example.test', HDS_MCP_ISSUES_KEY: KEY }), /go together/);
  assert.throws(() => issuesConfig({ HDS_MCP_ISSUES_URL: 'https://issues.example.test', HDS_MCP_ISSUES_KEY: 'short', HDS_MCP_ISSUES_KEY_ID: 'x' }), /at least 16/);
});

test('stdio default: unset gets the HDS intake (anonymous); an explicit value or empty string is kept', () => {
  const unset: NodeJS.ProcessEnv = {};
  applyStdioIssuesDefault(unset);
  assert.equal(unset.HDS_MCP_ISSUES_URL, STDIO_DEFAULT_ISSUES_URL);
  const cfg = issuesConfig(unset)!;
  assert.equal(cfg.base.href, 'https://issues.hds.ngo/');
  assert.equal(cfg.key, null);
  const explicit: NodeJS.ProcessEnv = { HDS_MCP_ISSUES_URL: 'http://127.0.0.1:6060' };
  applyStdioIssuesDefault(explicit);
  assert.equal(explicit.HDS_MCP_ISSUES_URL, 'http://127.0.0.1:6060');
  const optOut: NodeJS.ProcessEnv = { HDS_MCP_ISSUES_URL: '' };
  applyStdioIssuesDefault(optOut);
  assert.equal(issuesConfig(optOut), null);
});

test('the draft names the last failed tool of the session and the core error id; never report_problem itself', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { id: 'forbidden', message: 'no access to alice' } }), { status: 403 }));
  setApiEndpoint('https://tok123@alice.demo.datasafe.dev/', false, 'https://demo.datasafe.dev/reg/service/info');
  t.after(clearApiEndpoint);
  const server = buildServer();
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(() => client.close());
  const failed = await client.callTool({ name: 'list_streams', arguments: {} });
  assert.equal(failed.isError, true);
  const report = await client.callTool({ name: 'report_problem', arguments: { asked: 'list my streams', happened: 'list_streams failed' } });
  const body = new URL((report.content as Array<{ text: string }>)[0].text.split('\n').pop()!).searchParams.get('body') ?? '';
  assert.match(body, /- Last failed tool: list_streams\n- Core error id: forbidden\n/);
  assert.ok(!body.includes('alice'));
  // A second server (another session) knows nothing of the first one's failures.
  const other = buildServer();
  const c2 = new Client({ name: 'test', version: '0' });
  const [a2, b2] = InMemoryTransport.createLinkedPair();
  await Promise.all([other.connect(a2), c2.connect(b2)]);
  t.after(() => c2.close());
  const fresh = await c2.callTool({ name: 'report_problem', arguments: { asked: 'list my streams', happened: 'list_streams failed' } });
  const freshBody = new URL((fresh.content as Array<{ text: string }>)[0].text.split('\n').pop()!).searchParams.get('body') ?? '';
  assert.match(freshBody, /HDS MCP: /);
  assert.doesNotMatch(freshBody, /Last failed tool/);
});
