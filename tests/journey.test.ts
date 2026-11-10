import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extendWriteHint, isWriteCall, missingWriteScopes, rootNames, writeAccess } from '../src/http/stepUp.ts';
import { reportMissingItemHandler } from '../src/tools/reportMissingItem.ts';
import type { DataModelPack } from '../src/dataModel/pack.ts';

const pack = {
  items: {},
  streams: [
    { id: 'body', children: [{ id: 'body-weight' }, { id: 'body-vitals', children: [{ id: 'body-vitals-temperature' }] }] },
    { id: 'profile', children: [{ id: 'profile-name' }] }
  ]
} as unknown as DataModelPack;

const call = (name: string, args: unknown) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

test('step-up: a write to a root the token can only read needs <root>.contribute', () => {
  const body = call('create_event', { streamIds: ['body-vitals-temperature'], type: 'temperature/c' });
  assert.deepEqual(missingWriteScopes(body, ['offline_access', 'hds/stream/body.read'], pack), ['hds/stream/body.contribute']);
});

test('step-up: contribute or manage on the root or any model ancestor covers the write', () => {
  const body = call('create_event', { streamIds: ['body-vitals-temperature'], type: 'temperature/c' });
  assert.deepEqual(missingWriteScopes(body, ['hds/stream/body.contribute'], pack), []);
  assert.deepEqual(missingWriteScopes(body, ['hds/stream/body-vitals.manage'], pack), []);
});

test('step-up: import_batch collects every root once; streams outside the model are left to the core', () => {
  const body = call('import_batch', {
    events: [
      { streamIds: ['body-weight'], type: 'mass/kg' },
      { streamIds: ['body-weight'], type: 'mass/kg' },
      { streamIds: ['profile-name'], type: 'note/txt' },
      { streamIds: ['my-own-stream'], type: 'note/txt' }
    ]
  });
  assert.deepEqual(missingWriteScopes(body, [], pack).sort(), ['hds/stream/body.contribute', 'hds/stream/profile.contribute']);
});

test('step-up: reads, other methods and prototype names are not writes', () => {
  assert.equal(isWriteCall(call('get_events', {})), false);
  assert.equal(isWriteCall({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), false);
  assert.equal(isWriteCall(call('toString', {})), false);
  assert.equal(isWriteCall(call('create_event', {})), true);
  assert.deepEqual(missingWriteScopes(call('create_event', {}), [], pack), []);
});

test('write access: roots by name, write vs read only, and the reconnect hint', () => {
  const named = { items: {}, streams: [{ id: 'body', name: { en: 'Body' } }, { id: 'profile', name: 'Profile' }, { id: 'family' }] } as unknown as DataModelPack;
  assert.deepEqual(writeAccess(['offline_access', 'hds/stream/body.contribute', 'hds/stream/profile.read', 'hds/stream/family.manage'], named),
    { write: ['Body', 'family'], readOnly: ['Profile'] });
  assert.deepEqual(rootNames(['hds/stream/body.contribute', 'hds/stream/unknown.contribute'], named), ['Body', 'unknown']);
  assert.match(extendWriteHint(['Body']), /add data to "Body".*reconnects the HDS connector.*"Add and modify Body" ticked/);
  assert.match(extendWriteHint([]), /^To add data, the person reconnects/);
});

test('report_missing_item: a prefilled data-model-gap issue link with the kind, unit and codes only', async () => {
  const res = await reportMissingItemHandler({ kind: 'serum ferritin', source: 'printed lab report', unit: 'µg/L', codes: ['LOINC 2276-4'] });
  const url = new URL(res.content[0].text.split('\n').pop()!);
  assert.equal(url.origin + url.pathname, 'https://github.com/healthdatasafe/site-agents/issues/new');
  assert.equal(url.searchParams.get('template'), 'data-model-gap.md');
  assert.equal(url.searchParams.get('title'), 'Data model gap: serum ferritin');
  const body = url.searchParams.get('body') ?? '';
  assert.match(body, /serum ferritin from printed lab report \(unit: µg\/L\)/);
  assert.match(body, /LOINC 2276-4/);
  assert.match(res.content[0].text, /Nothing has been sent/);
});

test('get_import_guide: overview by default, every topic has content, tools named in the guides exist', async () => {
  const { getImportGuideHandler } = await import('../src/tools/getImportGuide.ts');
  const { GUIDE_TOPICS } = await import('../src/guides/content.ts');
  const { buildServer } = await import('../src/server.ts');
  assert.match((await getImportGuideHandler({})).content[0].text, /^# Importing/);
  // stdio tools plus the raw-mode ones (the guides cover both transports).
  const tools = [...Object.keys((buildServer() as any)._registeredTools), 'connect_status', 'disconnect'];
  for (const topic of GUIDE_TOPICS) {
    const text = (await getImportGuideHandler({ topic })).content[0].text;
    assert.ok(text.length > 200, topic);
    for (const name of text.match(/\b[a-z]+(?:_[a-z]+)+(?=\()/g) ?? []) assert.ok(tools.includes(name), `${topic} names ${name}`);
  }
});

test('get_connection: names the platform and suggests a throwaway demo account', async () => {
  const { getConnectionHandler } = await import('../src/tools/getConnection.ts');
  const { runWithCredentials } = await import('../src/auth/session.ts');
  const { platformOf } = await import('../src/lib/hostPolicy.ts');
  assert.equal(platformOf('https://reg.api.datasafe.dev/service/info'), 'production');
  assert.equal(platformOf('https://auth-ch.api.datasafe.dev'), 'production');
  assert.equal(platformOf('https://demo.datasafe.dev/reg/service/info'), 'demo');
  const demo = await runWithCredentials({ apiEndpoint: 'https://tok@demo.datasafe.dev/alice/', serviceInfoUrl: 'https://demo.datasafe.dev/reg/service/info', prodWritesEnabled: false },
    () => getConnectionHandler());
  assert.match(demo.content[0].text, /Connected to the HDS demo platform/);
  assert.match(demo.content[0].text, /demo-account\.datasafe\.dev\/register/);
  const prod = await runWithCredentials({ apiEndpoint: '', serviceInfoUrl: 'https://reg.api.datasafe.dev/service/info', prodWritesEnabled: false },
    () => getConnectionHandler());
  assert.match(prod.content[0].text, /Not connected yet; this session uses the HDS production platform.*real health record/);
});

test('server instructions name the platform of a remote MCP', async () => {
  const { buildServer } = await import('../src/server.ts');
  const instructions = (s: any) => s.server._instructions as string;
  assert.match(instructions(buildServer({ http: true, platform: 'demo' })), /HDS demo platform/);
  assert.match(instructions(buildServer({ http: true, platform: 'production' })), /production platform/);
  assert.match(instructions(buildServer()), /get_connection/);
});

const DRAFT_TEXT = /A draft was prepared; nothing is published until the person reviews and sends it\./;

test('report_problem without HDS_MCP_ISSUES_URL: a prefilled agent-problem issue link with the version, nothing published', async () => {
  const { reportProblemHandler } = await import('../src/tools/reportProblem.ts');
  const res = await reportProblemHandler({ asked: 'connect to my account', happened: 'connect_status: Sign-in could not be used', client: 'Claude.ai web', step: 'connect' });
  const url = new URL(res.content[0].text.split('\n').pop()!);
  assert.equal(url.origin + url.pathname, 'https://github.com/healthdatasafe/site-agents/issues/new');
  assert.equal(url.searchParams.get('template'), 'agent-problem.md');
  assert.equal(url.searchParams.get('title'), 'MCP problem: connect to my account');
  assert.match(url.searchParams.get('body') ?? '', /HDS MCP: \d+\.\d+\.\d+/);
  assert.match(res.content[0].text, DRAFT_TEXT);
  assert.doesNotMatch(res.content[0].text, /Nothing has been sent/);
});

test('report_problem with HDS_MCP_ISSUES_URL: the review page, the draft in the fragment, nothing published', async (t) => {
  const { reportProblemHandler } = await import('../src/tools/reportProblem.ts');
  process.env.HDS_MCP_ISSUES_URL = 'https://issues.example.test';
  t.after(() => { delete process.env.HDS_MCP_ISSUES_URL; });
  const res = await reportProblemHandler({ asked: 'connect to my account', happened: 'connect_status: Sign-in could not be used', client: 'Claude.ai web', step: 'connect' });
  const url = new URL(res.content[0].text.split('\n').pop()!);
  assert.equal(url.origin + url.pathname + url.search, 'https://issues.example.test/new');
  const draft = JSON.parse(Buffer.from(url.hash.slice(1), 'base64url').toString('utf8'));
  assert.equal(draft.title, 'MCP problem: connect to my account');
  assert.match(res.content[0].text, DRAFT_TEXT);
  assert.match(res.content[0].text, /no account needed/);
});

test('server instructions: report_problem prepares a draft, nothing published until the person sends it', async () => {
  const { buildServer } = await import('../src/server.ts');
  const s = buildServer() as any;
  assert.match(s.server._instructions, /offer report_problem: it prepares a draft, and nothing is published until the person reviews and sends it\./);
  assert.match(s._registeredTools.report_problem.description, /read, edit and send themselves; nothing is sent by this tool/);
});

test('ensure_streams: offered in stdio and raw mode (manage), never over OAuth', async () => {
  const { buildServer } = await import('../src/server.ts');
  const has = (s: any) => 'ensure_streams' in s._registeredTools;
  assert.equal(has(buildServer()), true);
  assert.equal(has(buildServer({ http: true, platform: 'production' })), true);
  assert.equal(has(buildServer({ http: true, oauth: true, platform: 'production' })), false);
});

test('open_account: the platform\'s account panel at the task page, username from access-info', async (t) => {
  const { openAccountHandler } = await import('../src/tools/openAccount.ts');
  const { runWithCredentials } = await import('../src/auth/session.ts');
  const { buildServer } = await import('../src/server.ts');
  const linkOf = (res: { content: Array<{ text: string }> }) => new URL(res.content[0].text.split('\n').pop()!);
  const seen: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL | string, init?: RequestInit) => {
    seen.push(`${url} ${(init?.headers as Record<string, string>)?.Authorization}`);
    return new Response(JSON.stringify({ type: 'app', user: { username: 'alice' } }), { status: 200 });
  });

  const prod = await runWithCredentials({ apiEndpoint: 'https://tok@core-us1-east.api.datasafe.dev/alice/', serviceInfoUrl: 'https://reg.api.datasafe.dev/service/info', prodWritesEnabled: true },
    () => openAccountHandler({ task: 'change_password' }));
  assert.equal(linkOf(prod).href, 'https://account.hds.ngo/change-password?username=alice');
  assert.deepEqual(seen, ['https://core-us1-east.api.datasafe.dev/alice/access-info tok']);
  assert.match(prod.content[0].text, /production platform.*"alice" is filled in.*Nothing has been changed/s);

  const email = await runWithCredentials({ apiEndpoint: 'https://tok@demo.datasafe.dev/alice/', serviceInfoUrl: 'https://demo.datasafe.dev/reg/service/info', prodWritesEnabled: false },
    () => openAccountHandler({ task: 'change_email' }));
  assert.equal(linkOf(email).href, 'https://demo-account.datasafe.dev/account/profile?username=alice');

  const reset = await runWithCredentials({ apiEndpoint: 'https://tok@demo.datasafe.dev/alice/', serviceInfoUrl: 'https://demo.datasafe.dev/reg/service/info', prodWritesEnabled: false },
    () => openAccountHandler({ task: 'reset_password' }));
  assert.match(reset.content[0].text, /enter their username, "alice"/);

  // Not signed in yet (raw mode before connect): the platform's page, no username, no API call.
  seen.length = 0;
  const signedOut = await runWithCredentials({ apiEndpoint: '', serviceInfoUrl: 'https://reg.api.datasafe.dev/service/info', prodWritesEnabled: false },
    () => openAccountHandler({ task: 'security' }));
  assert.equal(linkOf(signedOut).href, 'https://account.hds.ngo/account/security');
  assert.deepEqual(seen, []);

  // access-info failing still gives the page.
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 403 }));
  const failed = await runWithCredentials({ apiEndpoint: 'https://tok@demo.datasafe.dev/alice/', serviceInfoUrl: 'https://demo.datasafe.dev/reg/service/info', prodWritesEnabled: false },
    () => openAccountHandler({ task: 'connected_apps' }));
  assert.equal(linkOf(failed).href, 'https://demo-account.datasafe.dev/account/apps');

  assert.match((buildServer({ http: true, oauth: true, platform: 'production' }).server as any)._instructions, /open_account/);
});
