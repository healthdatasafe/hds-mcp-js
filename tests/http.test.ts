import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { createHttpApp } from '../src/http/app.ts';
import { introspectionVerifier } from '../src/http/introspection.ts';
import { httpMethods, initHttpObservability } from '../src/http/observability.ts';

// A fake core API: answers batch calls with the token it received, so each user can see whose token was used.
let api: http.Server;
let apiBase: string;
let mcp: http.Server;
let mcpUrl: string;

const listen = (s: http.Server) => new Promise<string>((resolve) => s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

before(async () => {
  api = http.createServer((req, res) => {
    const token = req.headers.authorization;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ results: [{ events: [{ id: `event-of-${token}`, type: 'note/txt', streamIds: ['x'] }] }] }));
  });
  apiBase = await listen(api);
  const users: Record<string, string> = { 'tok-alice': 'alice', 'tok-bob': 'bob' };
  const app = createHttpApp({
    publicUrl: new URL('http://127.0.0.1/mcp'),
    oauthMetadata: { issuer: 'https://issuer.test', authorization_endpoint: 'https://issuer.test/a', token_endpoint: 'https://issuer.test/t', response_types_supported: ['code'] },
    allowedOrigins: ['https://allowed.example'],
    connectorClients: { claude: 'hds-mcp-claude' },
    scopesSupported: ['offline_access', 'hds/stream/body.read'],
    verifier: {
      async verifyAccessToken (token: string) {
        if (!users[token]) throw new InvalidTokenError('Token is not active');
        const u = new URL(apiBase + '/');
        u.username = token;
        return { token, clientId: 'c', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600, extra: { credentials: { apiEndpoint: u.href, serviceInfoUrl: 'https://demo.datasafe.dev/reg/service/info', prodWritesEnabled: false } } };
      }
    }
  });
  mcp = http.createServer(app);
  mcpUrl = (await listen(mcp)) + '/mcp';
});

after(() => { api.close(); mcp.close(); });

const rpc = (token: string | null, body: unknown, headers: Record<string, string> = {}) => fetch(mcpUrl, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...headers
  },
  body: JSON.stringify(body)
});

const callGetEvents = (token: string) => rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_events', arguments: {} } });

test('no token: 401 pointing at the protected-resource metadata', async () => {
  const res = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /resource_metadata=/);
});

test('unknown token: 401', async () => {
  assert.equal((await callGetEvents('tok-mallory')).status, 401);
});

test('protected-resource metadata names the issuer and the scopes to ask for', async () => {
  const res = await fetch(mcpUrl.replace('/mcp', '/.well-known/oauth-protected-resource/mcp'));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { authorization_servers: string[], scopes_supported?: string[] };
  assert.deepEqual(body.authorization_servers, ['https://issuer.test']);
  assert.deepEqual(body.scopes_supported, ['offline_access', 'hds/stream/body.read']);
});

test('tools/list over HTTP has no connect tool', async () => {
  const res = await rpc('tok-alice', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = ((await res.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
  assert.ok(names.includes('get_events'));
  assert.ok(!names.includes('connect'));
});

test('initialize carries the privacy disclosure as server instructions', async () => {
  const res = await rpc('tok-alice', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  const instructions = ((await res.json()) as { result: { instructions?: string } }).result.instructions ?? '';
  assert.match(instructions, /sent to your model provider/);
});

test('concurrent users each reach the API with their own token', async () => {
  const [a, b] = await Promise.all([callGetEvents('tok-alice'), callGetEvents('tok-bob')]);
  const ta = JSON.stringify(await a.json());
  const tb = JSON.stringify(await b.json());
  assert.match(ta, /event-of-tok-alice/);
  assert.doesNotMatch(ta, /tok-bob/);
  assert.match(tb, /event-of-tok-bob/);
  assert.doesNotMatch(tb, /tok-alice/);
});

test('a foreign Origin is refused, an allowed one passes', async () => {
  assert.equal((await rpc('tok-alice', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await rpc('tok-alice', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: 'https://allowed.example' })).status, 200);
});

test('adapter manifest: public, CORS-readable from any origin, names the endpoint, issuer and clients', async () => {
  const res = await fetch(mcpUrl.replace('/mcp', '/manifest.json'), { headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const m = (await res.json()) as Record<string, unknown>;
  assert.equal(m.type, 'mcp');
  assert.equal(m.name, 'hds-mcp');
  assert.equal(m.mcpEndpoint, 'http://127.0.0.1/mcp');
  assert.equal(m.authorizationServer, 'https://issuer.test');
  assert.deepEqual(m.clients, { claude: 'hds-mcp-claude' });
  assert.ok(typeof m.version === 'string');
});

test('tools/list over HTTP has no ensure_streams (OAuth grants never carry manage)', async () => {
  const res = await rpc('tok-alice', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = ((await res.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
  assert.ok(!names.includes('ensure_streams'));
});

test('GET on the MCP path: 405', async () => {
  assert.equal((await fetch(mcpUrl)).status, 405);
});

test('GET /status: 200 with name and version, no token, any Origin', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const res = await fetch(mcpUrl.replace('/mcp', '/status'), { headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok', name: pkg.name, version: pkg.version });
});

test('observability: records registered route ids only, with status class and error code', async () => {
  const calls: string[] = [];
  const errors: string[] = [];
  const methods = httpMethods('/mcp');
  const app = createHttpApp({
    publicUrl: new URL('http://127.0.0.1/mcp'),
    oauthMetadata: { issuer: 'https://issuer.test', authorization_endpoint: 'https://issuer.test/a', token_endpoint: 'https://issuer.test/t', response_types_supported: ['code'] },
    allowedOrigins: [],
    verifier: { async verifyAccessToken () { throw new InvalidTokenError('Token is not active'); } },
    observability: { obs: { recordCall: (m, s) => { calls.push(`${m} ${s}`); }, recordError: (c) => { errors.push(c); } }, methods }
  });
  const s = http.createServer(app);
  const base = await listen(s);
  try {
    await fetch(`${base}/status`);
    await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await fetch(`${base}/.well-known/oauth-protected-resource/mcp?x=1`);
    await fetch(`${base}/users/alice/secret`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally { s.close(); }
  assert.deepEqual(calls.sort(), ['GET /.well-known/oauth-protected-resource/mcp 2xx', 'GET /status 2xx', 'POST /mcp 4xx']);
  assert.deepEqual(errors, ['UNAUTHORIZED']);
  assert.ok(calls.every((c) => methods.some((m) => c.startsWith(m + ' '))));
});

test('initHttpObservability: disabled without HDS_OTEL_ENDPOINT, named hds-<env>-mcp when set', async () => {
  assert.equal(await initHttpObservability({}, '1.0.0', httpMethods('/mcp')), null);
  const obs = await initHttpObservability({ HDS_OTEL_ENDPOINT: 'http://127.0.0.1:4318', HDS_ENV: 'demo' }, '1.0.0', httpMethods('/mcp'), async () => {});
  assert.ok(obs);
  await obs.stop();
});

test('introspectionVerifier: active token → credentials at api_base; prod, inactive and foreign audience refused', async () => {
  const answers: Record<string, unknown> = {
    good: { active: true, client_id: 'claude', scope: 'hds/stream/body.read', api_base: 'https://alice.demo.datasafe.dev/', aud: 'https://mcp.demo.datasafe.dev/mcp' },
    prod: { active: true, api_base: 'https://alice.api.datasafe.dev/', aud: 'https://mcp.demo.datasafe.dev/mcp' },
    dead: { active: false },
    other: { active: true, api_base: 'https://alice.demo.datasafe.dev/', aud: 'https://elsewhere.example/' },
    noaud: { active: true, api_base: 'https://alice.demo.datasafe.dev/' },
    plain: { active: true, api_base: 'http://alice.demo.datasafe.dev/', aud: 'https://mcp.demo.datasafe.dev/mcp' }
  };
  let calls = 0;
  const v = introspectionVerifier({
    introspectionEndpoint: 'https://issuer.test/oauth2/introspect',
    clientId: 'mcp',
    clientSecret: 's',
    resourceUrl: new URL('https://mcp.demo.datasafe.dev/mcp'),
    serviceInfoUrl: 'https://demo.datasafe.dev/reg/service/info',
    fetchFn: (async (_u: unknown, init: { body: string }) => {
      calls++;
      const token = new URLSearchParams(init.body).get('token')!;
      return new Response(JSON.stringify(answers[token]), { status: 200 });
    }) as unknown as typeof fetch
  });
  const info = await v.verifyAccessToken('good');
  assert.equal((info.extra!.credentials as { apiEndpoint: string }).apiEndpoint, 'https://good@alice.demo.datasafe.dev/');
  assert.deepEqual(info.scopes, ['hds/stream/body.read']);
  await v.verifyAccessToken('good');
  assert.equal(calls, 1, 'second call served from the cache');
  assert.ok(info.expiresAt! > Date.now() / 1000, 'no exp: expires at the end of the cache window');
  await assert.rejects(v.verifyAccessToken('prod'), /not available for production/);
  await assert.rejects(v.verifyAccessToken('dead'), /not active/);
  await assert.rejects(v.verifyAccessToken('other'), /not issued for this MCP/);
  await assert.rejects(v.verifyAccessToken('noaud'), /not issued for this MCP/, 'aud required by default');
  await assert.rejects(v.verifyAccessToken('plain'), /non-https API base/);
});

test('introspectionVerifier: requireAudience false accepts a token without aud, still refuses a foreign one', async () => {
  const answers: Record<string, unknown> = {
    noaud: { active: true, api_base: 'https://alice.demo.datasafe.dev/' },
    other: { active: true, api_base: 'https://alice.demo.datasafe.dev/', aud: 'https://elsewhere.example/' }
  };
  const v = introspectionVerifier({
    introspectionEndpoint: 'https://issuer.test/oauth2/introspect',
    clientId: 'mcp',
    clientSecret: 's',
    resourceUrl: new URL('https://mcp.demo.datasafe.dev/mcp'),
    serviceInfoUrl: 'https://demo.datasafe.dev/reg/service/info',
    requireAudience: false,
    fetchFn: (async (_u: unknown, init: { body: string }) =>
      new Response(JSON.stringify(answers[new URLSearchParams(init.body).get('token')!]), { status: 200 })) as unknown as typeof fetch
  });
  assert.ok(await v.verifyAccessToken('noaud'));
  await assert.rejects(v.verifyAccessToken('other'), /not issued for this MCP/);
});

test('introspectionVerifier: a stalled introspection endpoint times out', async () => {
  const v = introspectionVerifier({
    introspectionEndpoint: 'https://issuer.test/oauth2/introspect',
    clientId: 'mcp',
    clientSecret: 's',
    resourceUrl: new URL('https://mcp.demo.datasafe.dev/mcp'),
    serviceInfoUrl: 'https://demo.datasafe.dev/reg/service/info',
    timeoutMs: 20,
    fetchFn: ((_u: unknown, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    })) as unknown as typeof fetch
  });
  await assert.rejects(v.verifyAccessToken('any'), /TimeoutError|timed out|aborted/i);
});

test('introspectionVerifier: requireAudience refuses a token without aud, accepts the right one', async () => {
  const answers: Record<string, unknown> = {
    noaud: { active: true, api_base: 'https://alice.demo.datasafe.dev/' },
    right: { active: true, api_base: 'https://alice.demo.datasafe.dev/', aud: ['https://mcp.demo.datasafe.dev/mcp'] }
  };
  const v = introspectionVerifier({
    introspectionEndpoint: 'https://issuer.test/oauth2/introspect',
    clientId: 'mcp',
    clientSecret: 's',
    resourceUrl: new URL('https://mcp.demo.datasafe.dev/mcp'),
    serviceInfoUrl: 'https://demo.datasafe.dev/reg/service/info',
    requireAudience: true,
    fetchFn: (async (_u: unknown, init: { body: string }) =>
      new Response(JSON.stringify(answers[new URLSearchParams(init.body).get('token')!]), { status: 200 })) as unknown as typeof fetch
  });
  await assert.rejects(v.verifyAccessToken('noaud'), /not issued for this MCP/);
  assert.ok(await v.verifyAccessToken('right'));
});
