import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithCredentials, getApiEndpoint, setApiEndpoint, clearApiEndpoint, getProdWritesEnabled } from '../src/auth/session.ts';

const creds = (user: string) => ({
  apiEndpoint: `https://tok-${user}@${user}.demo.datasafe.dev/`,
  serviceInfoUrl: 'https://demo.datasafe.dev/reg/service/info',
  prodWritesEnabled: false
});

test('interleaved requests each see their own credentials', async () => {
  const seen: string[] = [];
  const req = (user: string, delay: number) => runWithCredentials(creds(user), async () => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    seen.push(`${user}:${getApiEndpoint()}`);
  });
  await Promise.all([req('alice', 20), req('bob', 5), req('carol', 10)]);
  assert.deepEqual(seen.sort(), [
    'alice:https://tok-alice@alice.demo.datasafe.dev/',
    'bob:https://tok-bob@bob.demo.datasafe.dev/',
    'carol:https://tok-carol@carol.demo.datasafe.dev/'
  ]);
});

test('a request never falls back to the stdio session', async () => {
  setApiEndpoint('https://tok-stdio@stdio.demo.datasafe.dev/', true);
  await runWithCredentials(creds('alice'), async () => {
    assert.equal(getApiEndpoint(), 'https://tok-alice@alice.demo.datasafe.dev/');
    assert.equal(getProdWritesEnabled(), false);
  });
  assert.equal(getApiEndpoint(), 'https://tok-stdio@stdio.demo.datasafe.dev/');
  clearApiEndpoint();
});

test('connect cannot overwrite credentials inside a request', async () => {
  await runWithCredentials(creds('alice'), async () => {
    assert.throws(() => setApiEndpoint('https://x@y/'), /connect is not available over HTTP/);
  });
});
