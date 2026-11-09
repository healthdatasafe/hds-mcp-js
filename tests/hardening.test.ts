import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { scrubTokens, scrubReport } from '../src/lib/scrubber.ts';
import { policyFetch, UpstreamError } from '../src/lib/fetchPolicy.ts';
import { errorCodeOf, toolErrorCodeOf, toolMethods, toolObserver, ERROR_CODES } from '../src/http/observability.ts';
import { buildServer, setToolObserver, TOOL_NAMES } from '../src/server.ts';
import { runWithCredentials } from '../src/auth/session.ts';
import { reportProblemHandler } from '../src/tools/reportProblem.ts';

test('scrubTokens: Bearer values and token-like parameters (B-2026-11-09-10)', () => {
  assert.equal(scrubTokens('Authorization: Bearer eyJhbGciOi.payload.sig'), 'Authorization: Bearer ***');
  assert.equal(scrubTokens('GET /events?auth=ck12345&limit=3'), 'GET /events?auth=***&limit=3');
  assert.equal(scrubTokens('callback?code=abc&state=x'), 'callback?code=***&state=x');
  assert.equal(scrubTokens('error_code=FORBIDDEN'), 'error_code=FORBIDDEN');
});

test('scrubReport: emails, per-user hosts, query strings, long ids and the account name; platform hosts and item keys kept', () => {
  const out = scrubReport(
    'alice (alice@example.com) at https://alice.api.datasafe.dev/events?streams=body&auth=x#top failed, ' +
    'token ckq3x9m2k0001abcdefghijk1, item fertility-cycles-average-peak-day, via https://reg.api.datasafe.dev/service/info ' +
    'and core-ch1.api.datasafe.dev, demo bob.demo.datasafe.dev',
    { username: 'alice' }
  );
  assert.equal(out,
    '{username} ([email]) at https://{username}.api.datasafe.dev/events?… failed, ' +
    'token [id], item fertility-cycles-average-peak-day, via https://reg.api.datasafe.dev/service/info ' +
    'and core-ch1.api.datasafe.dev, demo {username}.demo.datasafe.dev');
});

test('report_problem: the exact bytes of the link hold none of the identifiers (B-2026-11-09-10)', async () => {
  const secrets = ['alice', 'example.com', 'ckq3x9m2k0001abcdefghijk1', 'eyJhbGciOiJIUzI1NiJ9', 'sekret', 'tok123'];
  const res = await runWithCredentials(
    { apiEndpoint: 'https://tok123@alice.api.datasafe.dev/', serviceInfoUrl: 'https://reg.api.datasafe.dev/service/info', prodWritesEnabled: false },
    () => reportProblemHandler({
      asked: 'read alice weight',
      happened: 'get_events: Pryv events failed at https://tok123@alice.api.datasafe.dev/events?auth=sekret ' +
        'with Bearer eyJhbGciOiJIUzI1NiJ9.e30.x, token ckq3x9m2k0001abcdefghijk1, contact alice@example.com',
      client: 'Claude Code for alice',
      step: 'reading data'
    })
  );
  const href = res.content[0].text.split('\n').pop()!;
  const decoded = decodeURIComponent(href.replace(/\+/g, ' '));
  for (const s of secrets) {
    assert.ok(!href.toLowerCase().includes(s.toLowerCase()), `link bytes hold ${s}`);
    assert.ok(!decoded.toLowerCase().includes(s.toLowerCase()), `decoded link holds ${s}`);
  }
  const url = new URL(href);
  assert.equal(url.searchParams.get('title'), 'MCP problem: read {username} weight');
  assert.match(url.searchParams.get('body') ?? '', /get_events: Pryv events failed at https:\/\/\*\*\*@\{username\}\.api\.datasafe\.dev\/events\?…/);
});

async function serve (handler: http.RequestListener): Promise<{ base: string; close: () => void }> {
  const s = http.createServer(handler);
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => { s.closeAllConnections(); s.close(); } };
}

test('policyFetch: a redirect is answered, never followed; a silent upstream times out (B-2026-11-09-11)', async () => {
  let followed = 0;
  const srv = await serve((req, res) => {
    if (req.url === '/moved') { res.writeHead(302, { location: '/target' }).end(); return; }
    if (req.url === '/target') { followed++; res.end('{}'); }
    // /slow: never answers
  });
  try {
    const moved = await policyFetch(`${srv.base}/moved`);
    assert.equal(moved.status, 302);
    assert.equal(moved.ok, false);
    assert.equal(followed, 0);
    await assert.rejects(policyFetch(`${srv.base}/slow`, {}, 100), { name: 'TimeoutError', message: 'no answer within 0.1 s' });
  } finally { srv.close(); }
});

test('errorCodeOf: 429 is RATE_LIMITED, gateway errors UPSTREAM_ERROR, other 4xx BAD_REQUEST (B-2026-11-05-8)', () => {
  assert.equal(errorCodeOf(429), 'RATE_LIMITED');
  for (const c of [502, 503, 504]) assert.equal(errorCodeOf(c), 'UPSTREAM_ERROR');
  assert.equal(errorCodeOf(500), 'INTERNAL_ERROR');
  assert.equal(errorCodeOf(405), 'BAD_REQUEST');
  assert.equal(errorCodeOf(401), 'UNAUTHORIZED');
});

test('toolErrorCodeOf: upstream status, no answer, or the tool\'s own refusal', () => {
  assert.equal(toolErrorCodeOf(new UpstreamError('x', 500)), 'UPSTREAM_ERROR');
  assert.equal(toolErrorCodeOf(new UpstreamError('x', 429)), 'RATE_LIMITED');
  assert.equal(toolErrorCodeOf(new UpstreamError('x', 403)), 'FORBIDDEN');
  assert.equal(toolErrorCodeOf(Object.assign(new Error('no answer'), { name: 'TimeoutError' })), 'UPSTREAM_ERROR');
  assert.equal(toolErrorCodeOf(new TypeError('fetch failed')), 'UPSTREAM_ERROR');
  assert.equal(toolErrorCodeOf(new Error('Not connected')), 'TOOL_ERROR');
  for (const c of ['RATE_LIMITED', 'TOOL_ERROR']) assert.ok((ERROR_CODES as readonly string[]).includes(c));
});

test('tool telemetry: a failed tool call is recorded with its tool and code, a success is not; response shape unchanged (B-2026-11-09-12)', async () => {
  for (const s of [buildServer(), buildServer({ http: true, oauth: true }), buildServer({ http: true })]) {
    for (const name of Object.keys((s as any)._registeredTools)) assert.ok((TOOL_NAMES as readonly string[]).includes(name), name);
  }
  const calls: string[] = [];
  const errors: string[] = [];
  const methods = new Set(toolMethods(TOOL_NAMES));
  setToolObserver(toolObserver({
    recordCall: (m, s) => { assert.ok(methods.has(m), m); calls.push(`${m} ${s}`); },
    recordError: (c) => { errors.push(c); }
  }));
  const server = buildServer();
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const ok = await client.callTool({ name: 'get_connection', arguments: {} });
    const failed = await client.callTool({ name: 'list_streams', arguments: {} });
    assert.ok(!ok.isError);
    assert.equal(failed.isError, true);
    assert.match((failed.content as Array<{ text: string }>)[0].text, /Not connected/);
  } finally {
    setToolObserver(null);
    await client.close();
  }
  assert.deepEqual(calls, ['tool list_streams error']);
  assert.deepEqual(errors, ['TOOL_ERROR']);
});

test('loadPack: a failed load is retried by the next call, not kept', async () => {
  const { loadPack } = await import('../src/dataModel/pack.ts');
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async () => (++n === 1 ? new Response('down', { status: 503 }) : new Response(JSON.stringify({ items: {} })))) as typeof fetch;
  try {
    await assert.rejects(loadPack('https://pack.test/pack.json'), (err: UpstreamError) => err.status === 503);
    assert.deepEqual((await loadPack('https://pack.test/pack.json')).items, {});
  } finally { globalThis.fetch = realFetch; }
});
