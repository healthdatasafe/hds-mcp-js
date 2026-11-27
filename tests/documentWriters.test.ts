import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setApiEndpoint } from '../src/auth/session.ts';
import { createEventHandler } from '../src/tools/createEvent.ts';
import { updateEventHandler } from '../src/tools/updateEvent.ts';
import { listDocumentKindsHandler } from '../src/tools/listDocumentKinds.ts';

// plan 144: through the tools, a new document is written on ["documents"] alone and the results say it is not filed

const DEMO = 'https://tok123@demo.datasafe.dev/alice/';
const PACK_URL = 'https://model.datasafe.dev/pack.json';
const S = 'http://snomed.info/sct';
const LAB = { class: { system: S, code: '1', display: 'Lab' }, type: { system: S, code: '2', display: 'Lab report' } };
const pack = {
  version: '9.9.9',
  items: { document: { streamId: 'documents', eventType: 'file/xds-v1', type: 'document' } },
  streams: [{ id: 'documents', name: 'Medical documents', children: [{ id: 'documents-clinical', label: { en: 'Clinical documents' } }] }],
  eventTypes: { types: { 'file/xds-v1': { type: 'object', attachmentRequired: true, required: ['title'], properties: { title: { type: 'string' } } } } },
  documentKinds: {
    kinds: {
      'laboratory-report': { ...LAB, label: { en: 'Laboratory report' }, description: { en: 'Results' }, timeBasis: 'service', stream: 'documents-clinical' },
      other: { class: { system: S, code: '9' }, type: { system: S, code: '9' }, label: { en: 'Other' }, description: { en: 'Other' }, timeBasis: 'creation' }
    }
  }
};
const labContent = { title: 'Lab', class: LAB.class, type: [LAB.type] };

function mockCore (t: any, stored: any = null) {
  const posts: Array<{ url: string; body: any }> = [];
  t.mock.method(globalThis, 'fetch', async (url: URL | string, init?: RequestInit) => {
    const u = String(url);
    if (u === PACK_URL) return new Response(JSON.stringify(pack), { status: 200 });
    const body = init?.body != null ? JSON.parse(String(init.body)) : null;
    posts.push({ url: u, body });
    if (u.endsWith('/events')) return new Response(JSON.stringify({ event: { id: 'ev1', ...body } }), { status: 200 });
    const results = (body as any[]).map((c) => c.method === 'events.getOne' ? { event: stored } : { event: { ...stored, ...c.params.update } });
    return new Response(JSON.stringify({ results }), { status: 200 });
  });
  return posts;
}

async function refusal (p: Promise<unknown>): Promise<string> {
  try { await p; } catch (err) { return (err as Error).message; }
  assert.fail('expected a refusal');
}

beforeEach(() => { setApiEndpoint(DEMO); });

test('[DW1] create_event refuses a document filed or shared, nothing posted', async (t) => {
  const posts = mockCore(t);
  for (const streamIds of [['documents-clinical'], ['documents', 'share-x'], ['share-x', 'documents']]) {
    const msg = await refusal(createEventHandler({ streamIds, type: 'file/xds-v1', content: labContent }, { attachFile: true }));
    assert.match(msg, /^Event refused, nothing written: .*on stream "documents" alone/, streamIds.join());
  }
  assert.equal(posts.length, 0);
});

test('[DW2] create_event on ["documents"]: written, and the result says it is not filed and where it can go', async (t) => {
  const posts = mockCore(t);
  const res = await createEventHandler({ streamIds: ['documents'], type: 'file/xds-v1', content: labContent }, { attachFile: true });
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body.streamIds, ['documents']);
  assert.match(res.content[0].text, /Not filed: it is on "documents"\. The person can file it under "Clinical documents"/);
  assert.match(res.content[0].text, /add it with attach_file/);
});

test('[DW3] update_event: the note after a content change on the root, none when filed or for clientData only', async (t) => {
  mockCore(t, { id: 'ev1', type: 'file/xds-v1', streamIds: ['documents'], content: { title: 'x' } });
  const onRoot = await updateEventHandler({ id: 'ev1', update: { content: labContent } }, { attachFile: true });
  assert.match(onRoot.content[0].text, /^Updated event ev1\. Not filed: .*"Clinical documents"/);
  const cdOnly = await updateEventHandler({ id: 'ev1', update: { clientData: { a: 1 } } }, { attachFile: true });
  assert.equal(cdOnly.content[0].text, 'Updated event ev1.');
  t.mock.restoreAll();
  mockCore(t, { id: 'ev1', type: 'file/xds-v1', streamIds: ['documents-clinical'], content: { title: 'x' } });
  const filed = await updateEventHandler({ id: 'ev1', update: { content: labContent } }, { attachFile: true });
  assert.equal(filed.content[0].text, 'Updated event ev1.');
});

test('[DW4] list_document_kinds({ key }): where it is written and the class, never in the JSON', async (t) => {
  mockCore(t);
  const lab = await listDocumentKindsHandler({ key: 'laboratory-report' });
  assert.match(lab.content[0].text, /Write it on stream "documents" \(not filed\); the person can file it under "Clinical documents"/);
  assert.ok(!lab.content[1].text.includes('stream'));
  const other = await listDocumentKindsHandler({ key: 'other' });
  assert.match(other.content[0].text, /Write it on stream "documents" \(not filed\), where this kind stays\./);
});
