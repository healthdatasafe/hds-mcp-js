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
