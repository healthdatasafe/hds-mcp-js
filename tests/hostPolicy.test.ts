import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveServiceInfoUrl, isProdHost, assertWriteAllowed, PROD_WRITES_ENABLED } from '../src/lib/hostPolicy.ts';

test('resolveServiceInfoUrl defaults to demo', () => {
  assert.equal(resolveServiceInfoUrl(), 'https://reg.demo.datasafe.dev/service/info');
  assert.equal(resolveServiceInfoUrl(undefined), 'https://reg.demo.datasafe.dev/service/info');
  assert.equal(resolveServiceInfoUrl(''), 'https://reg.demo.datasafe.dev/service/info');
});

test('resolveServiceInfoUrl maps demo / prod aliases', () => {
  assert.equal(resolveServiceInfoUrl('demo'), 'https://reg.demo.datasafe.dev/service/info');
  assert.equal(resolveServiceInfoUrl('prod'), 'https://reg.datasafe.dev/service/info');
});

test('resolveServiceInfoUrl passes through full URLs', () => {
  const u = 'https://reg.example.com/service/info';
  assert.equal(resolveServiceInfoUrl(u), u);
});

test('resolveServiceInfoUrl rejects unknown alias', () => {
  assert.throws(() => resolveServiceInfoUrl('staging'), /Unrecognised host/);
});

test('isProdHost: demo apiEndpoint is not prod', () => {
  assert.equal(isProdHost('https://tok@alice.demo.datasafe.dev/'), false);
});

test('isProdHost: prod apiEndpoint is prod', () => {
  assert.equal(isProdHost('https://tok@alice.datasafe.dev/'), true);
});

test('isProdHost: unrelated host is not prod', () => {
  assert.equal(isProdHost('https://tok@example.com/'), false);
});

test('assertWriteAllowed: demo always allowed', () => {
  assert.doesNotThrow(() => assertWriteAllowed('https://tok@alice.demo.datasafe.dev/'));
});

test('assertWriteAllowed: prod refused when flag is false', () => {
  if (PROD_WRITES_ENABLED) {
    // Flag is on (e.g. integration env) — skip the negative assertion.
    return;
  }
  assert.throws(
    () => assertWriteAllowed('https://tok@alice.datasafe.dev/'),
    /Writes to the production HDS host are disabled/
  );
});
