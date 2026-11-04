import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allDataPermissions, rootPermissions } from '../src/tools/connect.ts';

const pack = {
  version: '9.9.9',
  items: {},
  streams: [
    { id: 'body', name: 'Body', label: { en: 'Body', fr: 'Corps' } },
    { id: 'genetics', name: 'Genetics', explicitGrantOnly: true },
    { id: 'profile', name: 'Profile' }
  ]
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(JSON.stringify(pack))) as typeof fetch;
test.after(() => { globalThis.fetch = realFetch; });

test('allDataPermissions: one permission per model root, never *, explicitGrantOnly roots left out', async () => {
  const { permissions, excluded } = await allDataPermissions();
  assert.deepEqual(permissions, [
    { streamId: 'body', level: 'contribute', defaultName: 'Body' },
    { streamId: 'profile', level: 'contribute', defaultName: 'Profile' }
  ]);
  assert.deepEqual(excluded, ['Genetics']);
});

test('allDataPermissions: level applies to every root', async () => {
  const { permissions } = await allDataPermissions('read');
  assert.ok(permissions.every((p) => p.level === 'read'));
});

test('rootPermissions: naming genetics is the explicit way in', async () => {
  assert.deepEqual(await rootPermissions([{ streamId: 'genetics', level: 'read' }]), [
    { streamId: 'genetics', level: 'read', defaultName: 'Genetics' }
  ]);
});

test('rootPermissions: * refused', async () => {
  await assert.rejects(rootPermissions([{ streamId: '*' }]), /roots must name streams/);
});
