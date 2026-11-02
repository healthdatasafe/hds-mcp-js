import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventsGetParams, ALL_TIME } from '../src/tools/getEvents.ts';
import { citingFirst } from '../src/tools/deleteEvents.ts';
import { modelPath } from '../src/tools/ensureStreams.ts';

test('eventsGetParams: plain query keeps defaults, no state, no clientData', () => {
  assert.deepEqual(eventsGetParams({ streams: ['body'] }), { limit: 100, streams: ['body'] });
});

test('eventsGetParams: sourceKey prefix widens the time range and filters on clientData', () => {
  assert.deepEqual(eventsGetParams({ sourceKeyPrefix: 'healthfiles:', state: 'all', limit: 1000 }), {
    limit: 1000,
    state: 'all',
    clientData: [{ path: 'sourceKey', prefix: 'healthfiles:' }],
    fromTime: ALL_TIME.fromTime,
    toTime: ALL_TIME.toTime
  });
});

test('eventsGetParams: explicit times win, relatedTo becomes an exists condition, skip pages', () => {
  const p = eventsGetParams({ relatedTo: 'abc', fromTime: 10, skip: 100 });
  assert.equal(p.fromTime, 10);
  assert.equal(p.toTime, ALL_TIME.toTime);
  assert.equal(p.skip, 100);
  assert.deepEqual(p.clientData, [{ path: 'related.abc', exists: true }]);
});

test('citingFirst: sources go after the events citing them', () => {
  const doc = { id: 'doc', type: 'file/xds-v1' };
  const val = { id: 'val', type: 'mass/kg', clientData: { related: { doc: true } } };
  const other = { id: 'other', type: 'note/txt' };
  assert.deepEqual(citingFirst([doc, val, other]).map((e) => e.id), ['val', 'other', 'doc']);
});

test('modelPath: root to leaf', () => {
  const tree = [{ id: 'body', children: [{ id: 'body-weight' }] }, { id: 'fertility' }];
  assert.deepEqual(modelPath(tree, 'body-weight')?.map((s) => s.id), ['body', 'body-weight']);
  assert.equal(modelPath(tree, 'nope'), undefined);
});
