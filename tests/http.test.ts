import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { createHttpApp } from '../src/http/app.ts';
import { introspectionVerifier } from '../src/http/introspection.ts';

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

test('protected-resource metadata names the issuer', async () => {
  const res = await fetch(mcpUrl.replace('/mcp', '/.well-known/oauth-protected-resource/mcp'));
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as { authorization_servers: string[] }).authorization_servers, ['https://issuer.test']);
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

test('GET on the MCP path: 405', async () => {
  assert.equal((await fetch(mcpUrl)).status, 405);
});

test('introspectionVerifier: active token → credentials at api_base; prod, inactive and foreign audience refused', async () => {
  const answers: Record<string, unknown> = {
    good: { active: true, client_id: 'claude', scope: 'hds/stream/body.read', api_base: 'https://alice.demo.datasafe.dev/', aud: 'https://mcp.demo.datasafe.dev/mcp' },
    prod: { active: true, api_base: 'https://alice.api.datasafe.dev/' },
    dead: { active: false },
    other: { active: true, api_base: 'https://alice.demo.datasafe.dev/', aud: 'https://elsewhere.example/' }
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
});
