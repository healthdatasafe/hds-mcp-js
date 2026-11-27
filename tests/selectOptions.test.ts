import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setApiEndpoint } from '../src/auth/session.ts';
import { itemForEvent, validateEvent } from '../src/dataModel/eventTypes.ts';
import { createEventHandler } from '../src/tools/createEvent.ts';
import { importBatchHandler } from '../src/tools/importBatch.ts';
import { updateEventHandler } from '../src/tools/updateEvent.ts';
import type { DataModelPack } from '../src/dataModel/pack.ts';

// B-2026-11-27-57: an item with options takes one of them, not any value its eventType allows (the renderers and the
// FHIR export know the options only)

const DEMO = 'https://tok123@demo.datasafe.dev/alice/';
const PACK_URL = 'https://model.datasafe.dev/pack.json';
const opt = (value: unknown, en: string) => ({ value, label: { en } });
const pack: DataModelPack = {
  version: '9.9.9',
  items: {
    'fertility-test-opk': {
      streamId: 'fertility-test-opk',
      eventType: 'test-result/scale',
      type: 'select',
      options: [opt(-1, 'Negative'), opt(0, 'Indeterminate'), opt(0.5, 'High (approaching peak)'), opt(1, 'Positive')]
    },
    'body-vulva-bleeding': {
      streamId: 'body-vulva-bleeding',
      eventType: 'ratio/proportion',
      type: 'select',
      options: [opt(0, 'None'), opt(0.35, 'Light'), opt(0.55, 'Moderate')]
    },
    'old-bleeding': { streamId: 'body-vulva-bleeding', eventType: 'ratio/proportion', type: 'number', deprecated: true },
    'lifestyle-diet-restriction': {
      streamId: 'lifestyle-diet-restriction',
      eventType: 'lifestyle/diet-restriction-v1',
      type: 'multi-select',
      options: [opt('gluten-free', 'Gluten-free'), opt('halal', 'Halal')]
    },
    'body-weight': { streamId: 'body-weight', eventType: 'mass/kg', type: 'number' }
  },
  eventTypes: {
    types: {
      'test-result/scale': { type: 'number', minimum: -1, maximum: 1 },
      'ratio/proportion': { type: 'number', minimum: 0, maximum: 1 },
      'lifestyle/diet-restriction-v1': { type: 'array', items: { type: 'string', enum: ['gluten-free', 'halal', 'kosher'] } },
      'mass/kg': { type: 'number' }
    }
  }
};

function mockCore (t: any, stored: any = null) {
  const posts: Array<{ url: string; body: any }> = [];
  t.mock.method(globalThis, 'fetch', async (url: URL | string, init?: RequestInit) => {
    const u = String(url);
    if (u === PACK_URL) return new Response(JSON.stringify(pack), { status: 200 });
    const body = init?.body != null ? JSON.parse(String(init.body)) : null;
    posts.push({ url: u, body });
    if (u.endsWith('/events')) return new Response(JSON.stringify({ event: { id: 'ev1', ...body } }), { status: 200 });
    const results = (body as any[]).map((c, i) => c.method === 'events.getOne'
      ? { event: stored }
      : c.method === 'events.create' ? { event: { id: `ev${i}`, ...c.params } } : { event: { ...stored, ...c.params.update } });
    return new Response(JSON.stringify({ results }), { status: 200 });
  });
  return posts;
}

async function refusal (p: Promise<unknown>): Promise<string> {
  try { await p; } catch (err) { return (err as Error).message; }
  assert.fail('expected a refusal');
}

beforeEach(() => { setApiEndpoint(DEMO); });

test('[OPT1] validateEvent with streamIds: a value of the options passes, another is refused naming the options', () => {
  assert.deepEqual(validateEvent(pack, 'test-result/scale', 0.5, { streamIds: ['fertility-test-opk'] }), []);
  const [p] = validateEvent(pack, 'test-result/scale', 0.3, { streamIds: ['fertility-test-opk'] });
  assert.equal(p, 'content 0.3 is not an option of item "fertility-test-opk". Allowed values: -1 (Negative), 0 (Indeterminate), ' +
    '0.5 (High (approaching peak)), 1 (Positive)');
  // without streamIds (or on a stream with no item), the eventType schema alone decides
  assert.deepEqual(validateEvent(pack, 'test-result/scale', 0.3), []);
  assert.deepEqual(validateEvent(pack, 'test-result/scale', 0.3, { streamIds: ['my-own-stream'] }), []);
  // a schema error is reported as before, not doubled by the options check
  assert.equal(validateEvent(pack, 'test-result/scale', 3, { streamIds: ['fertility-test-opk'] }).length, 1);
  assert.match(validateEvent(pack, 'test-result/scale', 3, { streamIds: ['fertility-test-opk'] })[0], /^content must be <= 1/);
});

test('[OPT2] multi-select: every value must be an option; the active item wins over a deprecated alias', () => {
  assert.deepEqual(validateEvent(pack, 'lifestyle/diet-restriction-v1', ['halal', 'gluten-free'], { streamIds: ['lifestyle-diet-restriction'] }), []);
  assert.deepEqual(validateEvent(pack, 'lifestyle/diet-restriction-v1', [], { streamIds: ['lifestyle-diet-restriction'] }), []);
  assert.match(validateEvent(pack, 'lifestyle/diet-restriction-v1', ['halal', 'kosher'], { streamIds: ['lifestyle-diet-restriction'] })[0],
    /^content "kosher" is not an option of item "lifestyle-diet-restriction"\. Allowed values: "gluten-free" \(Gluten-free\), "halal" \(Halal\)$/);
  assert.equal(itemForEvent(pack, ['share-x', 'body-vulva-bleeding'], 'ratio/proportion')?.key, 'body-vulva-bleeding');
  assert.equal(itemForEvent(pack, ['body-weight'], 'ratio/proportion'), null);
});

test('[OPT3] create_event refuses a value that is not an option, nothing posted; an option is written', async (t) => {
  const posts = mockCore(t);
  const msg = await refusal(createEventHandler({ streamIds: ['body-vulva-bleeding'], type: 'ratio/proportion', content: 0.5 }));
  assert.match(msg, /^Event refused, nothing written: content 0\.5 is not an option of item "body-vulva-bleeding"\. Allowed values: 0 \(None\), 0\.35 \(Light\), 0\.55 \(Moderate\)$/);
  assert.equal(posts.length, 0);
  await createEventHandler({ streamIds: ['body-vulva-bleeding'], type: 'ratio/proportion', content: 0.55 });
  assert.equal(posts.length, 1);
});

test('[OPT4] import_batch reports each row that is not an option, nothing written', async (t) => {
  const posts = mockCore(t);
  const msg = await refusal(importBatchHandler({
    events: [
      { streamIds: ['fertility-test-opk'], type: 'test-result/scale', content: 1 },
      { streamIds: ['fertility-test-opk'], type: 'test-result/scale', content: 0.3 },
      { streamIds: ['body-weight'], type: 'mass/kg', content: 70 },
      { streamIds: ['body-vulva-bleeding'], type: 'ratio/proportion', content: 0.5 }
    ]
  }));
  assert.match(msg, /^Batch refused, nothing written: 2 problem\(s\)\./);
  assert.match(msg, /\n {2}- \[1\] content 0\.3 is not an option of item "fertility-test-opk"/);
  assert.match(msg, /\n {2}- \[3\] content 0\.5 is not an option of item "body-vulva-bleeding"/);
  assert.equal(posts.length, 0);
});

test('[OPT5] update_event checks the new content against the options of the event\'s item', async (t) => {
  const posts = mockCore(t, { id: 'ev1', type: 'test-result/scale', streamIds: ['fertility-test-opk'], content: 1 });
  const msg = await refusal(updateEventHandler({ id: 'ev1', update: { content: 0.3 } }));
  assert.match(msg, /^Update refused, nothing written: content 0\.3 is not an option of item "fertility-test-opk"/);
  assert.equal(posts.length, 1, 'only the read');
  const ok = await updateEventHandler({ id: 'ev1', update: { content: -1 } });
  assert.equal(ok.content[0].text, 'Updated event ev1.');
});
