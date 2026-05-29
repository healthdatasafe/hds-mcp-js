import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubTokens, scrubError } from '../src/lib/scrubber.ts';

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
