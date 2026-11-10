import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubTokens, scrubError, scrubReport } from '../src/lib/scrubber.ts';

test('redacts token in apiEndpoint URL', () => {
  const apiEndpoint = 'https://abc123token@alice.demo.datasafe.dev/';
  assert.equal(scrubTokens(apiEndpoint), 'https://***@alice.demo.datasafe.dev/');
});

test('redacts token in middle of a longer string', () => {
  const msg = 'failed at https://xyzTOKEN@bob.datasafe.dev/events: 401';
  assert.equal(scrubTokens(msg), 'failed at https://***@bob.datasafe.dev/events: 401');
});

test('redacts multiple tokens in one string', () => {
  const msg = 'tried https://t1@a.demo.datasafe.dev/ then https://t2@b.demo.datasafe.dev/';
  assert.equal(
    scrubTokens(msg),
    'tried https://***@a.demo.datasafe.dev/ then https://***@b.demo.datasafe.dev/'
  );
});

test('redacts http (not just https)', () => {
  assert.equal(
    scrubTokens('http://tok@local.test/'),
    'http://***@local.test/'
  );
});

test('leaves urls without userinfo alone', () => {
  assert.equal(
    scrubTokens('https://reg.demo.datasafe.dev/service/info'),
    'https://reg.demo.datasafe.dev/service/info'
  );
});

test('redacts inside an object', () => {
  const obj = { apiEndpoint: 'https://tok@u.demo.datasafe.dev/', code: 401 };
  const out = scrubTokens(obj);
  assert.ok(!out.includes('tok@'), `expected token redacted, got: ${out}`);
  assert.ok(out.includes('***@'));
});

test('scrubError preserves name + redacts message and stack', () => {
  const e = new Error('boom https://leak@u.demo.datasafe.dev/');
  const scrubbed = scrubError(e);
  assert.equal(scrubbed.name, 'Error');
  assert.ok(!scrubbed.message.includes('leak@'));
  assert.ok(scrubbed.message.includes('***@'));
  if (e.stack) {
    assert.ok(scrubbed.stack && !scrubbed.stack.includes('leak@'));
  }
});

test('handles null / undefined gracefully', () => {
  assert.equal(scrubTokens(null), 'null');
  assert.equal(scrubTokens(undefined), 'undefined');
});

/**
 * The table hds-issues-service pins in its tests/scrub.test.ts (`D3_TABLE`, [SCR]): report_problem's draft goes to that
 * intake, which scrubs again with `scrubIntake`; without a username, scrubReport must give the very same bytes. Keep the
 * two tables in step. Its one `publishUsername` row is the reporter's opt-in on the review page, which the MCP never
 * sets, so it is not here.
 */
const INTAKE_TABLE: Array<{ rule: string, input: string, expected: string }> = [
  { rule: 'URL userinfo / apiEndpoint reduced to scheme + host', input: 'at https://ckq3tok@alice.api.datasafe.dev/events/abc?x=1 failed', expected: 'at https://***@{username}.api.datasafe.dev/ failed' },
  { rule: 'path-style apiEndpoint: the username in the path goes with the path', input: 'endpoint https://tok123@demo.datasafe.dev/alice/', expected: 'endpoint https://***@demo.datasafe.dev/' },
  { rule: 'Authorization header without a scheme (Pryv raw token)', input: 'Authorization: ckq3x9m2k0001', expected: 'Authorization: ***' },
  { rule: 'Authorization: Bearer', input: 'authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig', expected: 'authorization: ***' },
  { rule: 'Cookie header', input: 'Cookie: session=abcdef; other=1', expected: 'Cookie: ***' },
  { rule: 'Bearer anywhere', input: 'sent Bearer abc.def.ghi to the core', expected: 'sent Bearer *** to the core' },
  { rule: '?auth= and other secret parameters', input: 'GET /events?auth=sekret&limit=3', expected: 'GET /events?auth=***&limit=3' },
  { rule: 'JSON secret keys', input: '{"apiEndpoint":"https://t@x.test/","password":"hunter22","token":"tok","name":"ok"}', expected: '{"apiEndpoint":"***","password":"***","token":"***","name":"ok"}' },
  { rule: 'emails', input: 'contact alice@example.com please', expected: 'contact [email] please' },
  { rule: 'per-user hostnames (api)', input: 'host alice.api.datasafe.dev down', expected: 'host {username}.api.datasafe.dev down' },
  { rule: 'per-user hostnames (demo)', input: 'host bob.demo.datasafe.dev down', expected: 'host {username}.demo.datasafe.dev down' },
  { rule: 'platform hostnames kept', input: 'https://reg.api.datasafe.dev/service/info and core-ch1.api.datasafe.dev', expected: 'https://reg.api.datasafe.dev/service/info and core-ch1.api.datasafe.dev' },
  { rule: 'query strings and fragments on any URL', input: 'see https://app.hds.ngo/invite?key=xyz#top', expected: 'see https://app.hds.ngo/invite?…' },
  { rule: 'long opaque values (tokens, keys)', input: 'token ckq3x9m2k0001abcdefghijk1 here', expected: 'token [id] here' },
  { rule: 'item keys and stream ids kept', input: 'item fertility-cycles-average-peak-day', expected: 'item fertility-cycles-average-peak-day' }
];

for (const row of INTAKE_TABLE) {
  test(`scrubReport = hds-issues-service scrubIntake: ${row.rule}`, () => {
    assert.equal(scrubReport(row.input), row.expected);
    // The intake scrubs the MCP's output again: nothing changes the second time.
    assert.equal(scrubReport(row.expected), row.expected);
  });
}

test('scrubReport with the connected account name: the name goes too, the intake rules still apply', () => {
  assert.equal(
    scrubReport('alice: GET https://tok@alice.api.datasafe.dev/events?auth=x failed', { username: 'alice' }),
    '{username}: GET https://***@{username}.api.datasafe.dev/ failed'
  );
});
