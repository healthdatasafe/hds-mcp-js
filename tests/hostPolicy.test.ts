import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveServiceInfoUrl, isProdHost, assertWriteAllowed, PROD_WRITES_ENABLED } from '../src/lib/hostPolicy.ts';

test('resolveServiceInfoUrl defaults to demo', () => {
  assert.equal(resolveServiceInfoUrl(), 'https://demo.datasafe.dev/reg/service/info');
  assert.equal(resolveServiceInfoUrl(undefined), 'https://demo.datasafe.dev/reg/service/info');
  assert.equal(resolveServiceInfoUrl(''), 'https://demo.datasafe.dev/reg/service/info');
});

test('resolveServiceInfoUrl maps demo / prod aliases', () => {
  assert.equal(resolveServiceInfoUrl('demo'), 'https://demo.datasafe.dev/reg/service/info');
  assert.equal(resolveServiceInfoUrl('prod'), 'https://reg.api.datasafe.dev/service/info');
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
  assert.equal(isProdHost('https://tok@alice.api.datasafe.dev/'), true);
});

test('isProdHost: bare datasafe.dev is not prod (apiEndpoints use *.api.datasafe.dev)', () => {
  assert.equal(isProdHost('https://tok@alice.datasafe.dev/'), false);
});

test('isProdHost: unrelated host is not prod', () => {
  assert.equal(isProdHost('https://tok@example.com/'), false);
});

test('assertWriteAllowed: demo always allowed', () => {
  assert.doesNotThrow(() => assertWriteAllowed('https://tok@alice.demo.datasafe.dev/'));
  assert.doesNotThrow(() => assertWriteAllowed('https://tok@alice.demo.datasafe.dev/', false));
});

test('assertWriteAllowed: prod refused without session opt-in', () => {
  if (PROD_WRITES_ENABLED) {
    // Env flag is on (e.g. integration env) — skip the negative assertion.
    return;
  }
  assert.throws(
    () => assertWriteAllowed('https://tok@alice.api.datasafe.dev/'),
    /Writes to the production HDS host are disabled for this session/
  );
  assert.throws(
    () => assertWriteAllowed('https://tok@alice.api.datasafe.dev/', false),
    /enableWrites: true/
  );
});

test('assertWriteAllowed: prod allowed with session opt-in (connect enableWrites)', () => {
  assert.doesNotThrow(() => assertWriteAllowed('https://tok@alice.api.datasafe.dev/', true));
});
