import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemEventTypes, validateEvent } from '../src/dataModel/eventTypes.ts';
import { scoreItem } from '../src/tools/searchItems.ts';
import type { DataModelPack, ItemDef } from '../src/dataModel/pack.ts';

const pack: DataModelPack = {
  version: '9.9.9',
  items: {},
  eventTypes: {
    types: {
      'mass/kg': { type: 'number' },
      'checkbox/null': { type: 'null' },
      'lab-result/coded-v1': {
        type: 'object',
        additionalProperties: false,
        required: ['analyte'],
        dependencies: { value: ['unit'] },
        properties: { analyte: { type: 'object' }, value: { type: 'number' }, unit: { type: 'string' } }
      },
      'file/xds-v1': { type: 'object', attachmentRequired: true }
    }
  }
};

const weight: ItemDef = {
  streamId: 'body-weight',
  type: 'number',
  variations: { eventType: { options: [{ value: 'mass/kg' }, { value: 'mass/lb' }] } }
};

test('itemEventTypes: top-level eventType', () => {
  assert.deepEqual(itemEventTypes({ streamId: 's', type: 'number', eventType: 'mass/kg' }), ['mass/kg']);
});

test('itemEventTypes: unit choice from variations', () => {
  assert.deepEqual(itemEventTypes(weight), ['mass/kg', 'mass/lb']);
});

test('scoreItem: an item without top-level eventType does not throw', () => {
  assert.ok(scoreItem('body-weight', weight, 'weight') > 0);
  assert.ok(scoreItem('body-weight', weight, 'mass/lb') > 0);
});

test('validateEvent: valid content passes', () => {
  assert.deepEqual(validateEvent(pack, 'mass/kg', 72.5), []);
  assert.deepEqual(validateEvent(pack, 'checkbox/null', undefined), []);
  assert.deepEqual(validateEvent(pack, 'lab-result/coded-v1', { analyte: {}, value: 5, unit: 'mmol/L' }), []);
});

test('validateEvent: wrong content is refused', () => {
  assert.equal(validateEvent(pack, 'mass/kg', '72').length, 1);
  assert.equal(validateEvent(pack, 'mass/kg', undefined).length, 1);
});

test('validateEvent: closed object rejects a misspelt key and a value without unit', () => {
  const problems = validateEvent(pack, 'lab-result/coded-v1', { analyte: {}, valu: 5 });
  assert.ok(problems.some((p) => /additional properties/.test(p)));
  assert.ok(validateEvent(pack, 'lab-result/coded-v1', { analyte: {}, value: 5 }).length > 0);
});

test('validateEvent: unknown type is refused with the pack version', () => {
  assert.match(validateEvent(pack, 'mass/kilo', 1)[0], /^Unknown event type "mass\/kilo": not in the HDS data model \(data-model 9\.9\.9\)/);
});

test('validateEvent: attachment types are refused', () => {
  assert.match(validateEvent(pack, 'file/xds-v1', {})[0], /needs an attachment, which this MCP cannot upload yet/);
});

test('validateEvent: the local MCP writes an attachment type one event at a time, content checked', () => {
  assert.deepEqual(validateEvent(pack, 'file/xds-v1', {}, { attachFile: true }), []);
  assert.match(validateEvent(pack, 'file/xds-v1', 'x', { attachFile: true })[0], /^content must be object/);
  assert.equal(validateEvent(pack, 'file/xds-v1', {}, { attachFile: true, batch: true })[0],
    'Event type "file/xds-v1" needs an attachment: create it with create_event, then add its file with attach_file.');
});

test('get_event_type and create_event: attach_file named on stdio only', async (t) => {
  const { buildServer } = await import('../src/server.ts');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(pack), { status: 200 }));
  const { loadPack } = await import('../src/dataModel/pack.ts');
  await loadPack();
  const read = async (s: ReturnType<typeof buildServer>) => {
    const client = new Client({ name: 'test', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([s.connect(a), client.connect(b)]);
    try {
      const res = await client.callTool({ name: 'get_event_type', arguments: { type: 'file/xds-v1' } });
      return (res.content as Array<{ text: string }>)[0].text;
    } finally { await client.close(); }
  };
  assert.match(await read(buildServer()), /Needs an attachment: create the event with create_event .*then add its file with attach_file/);
  assert.match(await read(buildServer({ http: true, oauth: true, platform: 'demo' })), /Needs an attachment: not writable through this MCP \(only the local HDS MCP/);
  const desc = (s: any) => s._registeredTools.create_event.description as string;
  assert.match(desc(buildServer()), /add the file next with attach_file/);
  assert.doesNotMatch(desc(buildServer({ http: true, oauth: true, platform: 'demo' })), /attach_file/);
});
