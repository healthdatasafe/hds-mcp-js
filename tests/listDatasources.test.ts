import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemsUsingDatasource } from '../src/tools/listDatasources.ts';
import type { DataModelPack } from '../src/dataModel/pack.ts';

const pack = {
  items: {
    'condition-coded': { streamId: 'condition', type: 'datasource-search', datasource: 'condition' },
    'allergy-coded': {
      streamId: 'allergy',
      type: 'composite',
      composite: { allergen: { type: 'datasource-search', datasource: 'allergen' }, status: { type: 'select' } }
    },
    'allergy-basic': { streamId: 'allergy', type: 'composite', composite: { name: { type: 'text' } } },
    'old-coded': { streamId: 'x', type: 'datasource-search', datasource: 'allergen', deprecated: true }
  }
} as unknown as DataModelPack;

test('itemsUsingDatasource: item-level and composite-field datasources, deprecated left out', () => {
  assert.deepEqual(itemsUsingDatasource(pack, 'condition'), ['condition-coded']);
  assert.deepEqual(itemsUsingDatasource(pack, 'allergen'), ['allergy-coded']);
  assert.deepEqual(itemsUsingDatasource(pack, 'manifestation'), []);
});
