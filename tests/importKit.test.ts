import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DataModelPack } from '../src/dataModel/pack.ts';
import { loadPackage } from '../src/import/pkg.ts';
import { buildReport, normalizePackage } from '../src/import/inspect.ts';
import { verifyPackage, writePackage, type Transport } from '../src/import/writer.ts';
import { renderReview } from '../src/import/review.ts';

// plan 130 (site-agents#36 A4/A5): the local import kit against a fixture pack and a fake core that applies writes as
// the core does (clientData merged key by key, null removes a key; trashed events stay; clientData filters).

const SECRET = 'SECRET-VALUE-Ünïque';

const pack: DataModelPack = {
  version: '9.9.9',
  items: {
    'body-weight': { streamId: 'body-weight', eventType: 'mass/kg', type: 'number', label: { en: 'Body weight' } },
    note: { streamId: 'body-notes', eventType: 'note/txt', type: 'text', label: { en: 'Note' } },
    document: { streamId: 'documents', eventType: 'file/xds-v1', type: 'document', label: { en: 'Document' } },
    practitioner: { streamId: 'encounter-providers', eventType: 'provider/practitioner-v1', type: 'provider', label: { en: 'Practitioner' } }
  },
  streams: [
    { id: 'body', label: { en: 'Body' }, children: [{ id: 'body-weight' }, { id: 'body-notes' }] },
    { id: 'documents', label: { en: 'Documents' } },
    { id: 'encounter', label: { en: 'Care' }, children: [{ id: 'encounter-providers' }] }
  ],
  eventTypes: {
    types: {
      'mass/kg': { type: 'number' },
      'note/txt': { type: 'string' },
      'file/xds-v1': {
        type: 'object',
        attachmentRequired: true,
        required: ['title'],
        properties: {
          title: { type: 'string' },
          uniqueId: { type: 'object' },
          supersedes: { type: 'array', items: { type: 'string' } },
          authors: { type: 'array', items: { type: 'object', properties: { eventId: { type: 'string' }, name: { type: 'string' } } } }
        }
      },
      'provider/practitioner-v1': { type: 'object', properties: { name: { type: 'string' }, identifiers: { type: 'array' } } }
    }
  }
};

const T0 = Date.UTC(2024, 0, 15) / 1000;
const PDF = Buffer.from('%PDF-1.4\n% test\n');

async function makePackage (events: any[], { tool = 'testkit', files = { 'files/report.pdf': PDF } as Record<string, Buffer>, manifest = {} as any } = {}): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hds-import-'));
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ format: 'hds-import-package/1', importName: 'test-import', tool, ...manifest }));
  await fsp.writeFile(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  for (const [rel, data] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fsp.writeFile(path.join(dir, rel), data);
  }
  return dir;
}

const baseEvents = () => [
  { sourceKey: 'testkit:weight:1', itemKey: 'body-weight', content: 70.5, time: T0, description: SECRET },
  { sourceKey: 'testkit:prov:dr', itemKey: 'practitioner', content: { name: 'Dr X', identifiers: [{ system: 'urn:oid:2.51.1.3', value: '7601000000000' }] }, time: T0 },
  {
    sourceKey: 'testkit:doc:1',
    itemKey: 'document',
    content: { title: 'Lab report', uniqueId: { system: 'urn:ietf:rfc:3986', value: 'urn:oid:2.999.1' }, authors: [{ eventId: { $ref: 'testkit:prov:dr' }, name: 'Dr X' }] },
    time: T0,
    attachment: 'files/report.pdf',
    evidence: { file: 'files/report.pdf', page: 1 }
  }
];

/** A fake core: events by id, clientData filters, merge on update, uploads. */
function fakeCore ({ failUploads = false } = {}) {
  const events = new Map<string, any>();
  let n = 0;
  const writes: string[] = [];
  const matches = (e: any, p: any) => (p.types == null || p.types.includes(e.type)) &&
    (p.state === 'all' || !e.trashed) &&
    (p.clientData ?? []).every((c: any) => {
      const v = c.path.split('.').reduce((o: any, k: string) => o?.[k], e.clientData);
      return c.prefix != null ? (typeof v === 'string' && v.startsWith(c.prefix)) : c.eq != null ? v === c.eq : c.exists ? v != null : true;
    });
  const t: Transport = {
    batch: async (calls) => calls.map((c) => {
      if (c.method === 'events.get') {
        const all = [...events.values()].filter((e) => matches(e, c.params));
        return { events: structuredClone(all.slice(c.params.skip ?? 0, (c.params.skip ?? 0) + (c.params.limit ?? 20))) };
      }
      writes.push(c.method);
      if (c.method === 'events.create') {
        const e = { ...structuredClone(c.params), id: `ev${++n}`, created: n };
        events.set(e.id, e);
        return { event: structuredClone(e) };
      }
      if (c.method === 'events.update') {
        const e = events.get(c.params.id);
        if (!e) return { error: { id: 'unknown-resource' } };
        const { clientData, ...rest } = c.params.update;
        Object.assign(e, structuredClone(rest));
        if (clientData) {
          e.clientData = { ...(e.clientData ?? {}) };
          for (const [k, v] of Object.entries(clientData)) { if (v == null) delete e.clientData[k]; else e.clientData[k] = v; }
        }
        return { event: structuredClone(e) };
      }
      return { error: { id: 'unexpected' } };
    }),
    upload: async (id, file) => {
      writes.push('upload');
      if (failUploads) throw Object.assign(new Error('timeout'), { errorId: 'timeout' });
      const e = events.get(id);
      e.attachments = [...(e.attachments ?? []), { id: 'att' + id, fileName: file.name, size: file.data.length }];
      return { event: e };
    }
  };
  return { t, events, writes };
}

async function run (dir: string, core: ReturnType<typeof fakeCore>) {
  const pkg = await loadPackage(dir);
  const n = await normalizePackage(pkg, pack);
  return { pkg, n, report: buildReport(pkg, pack, n), write: () => writePackage(pkg, n, core.t), verify: () => verifyPackage(pkg, n, core.t) };
}

test('[IMP1] inspect: a valid package gives counts and roots, and no value', async () => {
  const { report } = await run(await makePackage(baseEvents()), fakeCore());
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual(report.roots, ['body', 'documents', 'encounter']);
  assert.deepEqual(report.byItem, { 'body-weight': 1, practitioner: 1, document: 1 });
  assert.equal(report.documents, 1);
  assert.ok(!JSON.stringify(report).includes(SECRET));
  assert.ok(!JSON.stringify(report).includes('70.5'));
});

test('[IMP2] inspect refuses what a re-run could not handle', async () => {
  const dir = await makePackage([
    { sourceKey: 'testkit:w:1', itemKey: 'body-weight', content: 70, time: T0 },
    { sourceKey: 'testkit:w:1', itemKey: 'body-weight', content: 71, time: T0 },
    { sourceKey: 'testkit:w:2', itemKey: 'body-weight', content: 70 },
    { sourceKey: 'testkit:w:3', itemKey: 'body-weight', content: 70, time: Date.UTC(2150, 0, 1) / 1000 },
    { sourceKey: 'other:w:4', itemKey: 'body-weight', content: 70, time: T0 },
    { sourceKey: 'testkit:w:5', itemKey: 'body-weight', content: SECRET, time: T0 },
    { sourceKey: 'testkit:w:6', itemKey: 'body-weight', content: 70, time: T0, clientData: { sourceKey: 'x' } },
    { sourceKey: 'testkit:d:1', itemKey: 'document', content: { title: 't', supersedes: [{ $ref: 'testkit:nope:1' }] }, time: T0, attachment: 'files/report.pdf' },
    { sourceKey: 'testkit:d:2', itemKey: 'document', content: { title: 't' }, time: T0 },
    { sourceKey: 'testkit:d:3', itemKey: 'document', content: { title: 't', supersedes: [{ $ref: 'testkit:d:4' }] }, time: T0, attachment: 'files/report.pdf' },
    { sourceKey: 'testkit:d:4', itemKey: 'document', content: { title: 't', supersedes: [{ $ref: 'testkit:d:3' }] }, time: T0, attachment: 'files/report.pdf' },
    { sourceKey: 'testkit:d:5', itemKey: 'document', content: { title: 't' }, time: T0, attachment: 'files/fake.pdf' },
    { sourceKey: 'testkit:d:6', itemKey: 'document', content: { title: 't' }, time: T0, attachment: '../outside.pdf' }
  ], { files: { 'files/report.pdf': PDF, 'files/fake.pdf': Buffer.from('not a pdf') } });
  const { report } = await run(dir, fakeCore());
  const codes = report.problems.map((p) => `${p.line}:${p.code}`);
  for (const c of ['2:sourcekey-duplicate', '3:time-missing', '4:time-out-of-range', '5:sourcekey-tool', '6:content-invalid',
    '7:clientdata-reserved-key', '8:ref-dangling', '9:attachment-missing', '10:ref-cycle', '11:ref-cycle', '12:attachment-format',
    '13:attachment-file-path-outside']) {
    assert.ok(codes.includes(c), `${c} in ${codes.join(' ')}`);
  }
  assert.equal(report.ok, false);
  assert.ok(!JSON.stringify(report).includes(SECRET), 'no value in a problem');
});

test('[IMP3] inspect refuses another writer\'s sourceKey prefix', async () => {
  for (const tool of ['femm', 'bridge-mira']) {
    const { report } = await run(await makePackage([{ sourceKey: `${tool}:w:1`, itemKey: 'body-weight', content: 70, time: T0 }], { tool }), fakeCore());
    assert.ok(report.problems.some((p) => p.code === 'manifest-tool-reserved'), tool);
  }
});

test('[IMP4] write: sources first, $ref resolved, links mirrored, file uploaded; a second run writes nothing', async () => {
  const core = fakeCore();
  const r = await run(await makePackage(baseEvents()), core);
  const res = await r.write();
  assert.deepEqual(res.errors, []);
  assert.equal(res.counts.created, 3);
  assert.equal(res.counts.filesUploaded, 1);
  const all = [...core.events.values()];
  const prov = all.find((e) => e.type === 'provider/practitioner-v1');
  const doc = all.find((e) => e.type === 'file/xds-v1');
  assert.ok(Number(prov.id.slice(2)) < Number(doc.id.slice(2)), 'the provider is written before the document citing it');
  assert.equal(doc.content.authors[0].eventId, prov.id);
  assert.deepEqual(doc.clientData.related, { [prov.id]: true });
  assert.equal(doc.clientData.hdsDocumentUniqueId, 'urn:ietf:rfc:3986|urn:oid:2.999.1');
  assert.equal(prov.clientData.hdsGln, '7601000000000');
  assert.equal(doc.attachments.length, 1);

  core.writes.length = 0;
  const again = await r.write();
  assert.deepEqual(core.writes, [], 'a re-run makes zero write calls');
  assert.equal(again.counts.unchanged, 3);
  assert.deepEqual(await r.verify(), { checked: 3, missing: 0, trashed: 0, different: 0, documentsWithoutFile: 0, orphans: 0, duplicateKeys: 0, differences: [] });
});

test('[IMP5] a changed value is one update with only what changed; clientData keys of other writers stay', async () => {
  const core = fakeCore();
  const events = baseEvents();
  await (await run(await makePackage(events), core)).write();
  const weight = [...core.events.values()].find((e) => e.type === 'mass/kg');
  weight.clientData.otherApp = 'kept';
  events[0].content = 72;
  core.writes.length = 0;
  const r = await run(await makePackage(events), core);
  const res = await r.write();
  assert.equal(res.counts.updated, 1);
  assert.deepEqual(core.writes, ['events.update']);
  assert.equal(weight.content, 72);
  assert.equal(weight.clientData.otherApp, 'kept');
  assert.equal(weight.clientData.sourceKey, 'testkit:weight:1');
});

test('[IMP6] a trashed event stays in the trash', async () => {
  const core = fakeCore();
  const events = baseEvents();
  await (await run(await makePackage(events), core)).write();
  const weight = [...core.events.values()].find((e) => e.type === 'mass/kg');
  weight.trashed = true;
  events[0].content = 99;
  core.writes.length = 0;
  const r = await run(await makePackage(events), core);
  const res = await r.write();
  assert.equal(res.counts.trashed, 1);
  assert.deepEqual(core.writes, []);
  assert.equal(weight.content, 70.5);
  assert.equal((await r.verify()).trashed, 1);
});

test('[IMP7] a run cut between create and upload: the next run adds the file, no duplicate', async () => {
  const failing = fakeCore({ failUploads: true });
  const dir = await makePackage(baseEvents());
  const first = await (await run(dir, failing)).write();
  assert.equal(first.counts.created, 3);
  assert.equal(first.errors[0].code, 'upload-timeout');
  const v = await (await run(dir, failing)).verify();
  assert.equal(v.documentsWithoutFile, 1);
  // same account, uploads working again
  const healed = { ...failing, t: { ...failing.t, upload: fakeCore().t.upload } };
  healed.t.upload = async (id, file) => {
    const e = failing.events.get(id);
    e.attachments = [{ id: 'a', fileName: file.name }];
    return { event: e };
  };
  failing.writes.length = 0;
  const second = await (await run(dir, healed)).write();
  assert.equal(second.counts.created, 0);
  assert.equal(second.counts.filesUploaded, 1);
  assert.equal(failing.events.size, 3, 'no duplicate');
});

test('[IMP8] a document already held under its identifier is linked, not duplicated', async () => {
  const core = fakeCore();
  await core.t.batch([{ method: 'events.create', params: { streamIds: ['documents'], type: 'file/xds-v1', time: T0, content: { title: 'From the EPR' }, clientData: { sourceKey: 'epr:doc:9', hdsDocumentUniqueId: 'urn:ietf:rfc:3986|urn:oid:2.999.1' } } }]);
  const res = await (await run(await makePackage(baseEvents()), core)).write();
  assert.equal(res.counts.heldElsewhere, 1);
  assert.equal(res.counts.created, 2);
  assert.equal([...core.events.values()].filter((e) => e.type === 'file/xds-v1').length, 1);
});

test('[IMP9] two account events under one key: stop, nothing written', async () => {
  const core = fakeCore();
  for (let i = 0; i < 2; i++) await core.t.batch([{ method: 'events.create', params: { streamIds: ['body-weight'], type: 'mass/kg', time: T0, content: 1, clientData: { sourceKey: 'testkit:weight:1' } } }]);
  core.writes.length = 0;
  await assert.rejects((await run(await makePackage(baseEvents()), core)).write(), /two events under one sourceKey/);
  assert.deepEqual(core.writes, []);
});

test('[IMP10] orphans are counted, never deleted', async () => {
  const core = fakeCore();
  await (await run(await makePackage(baseEvents()), core)).write();
  core.writes.length = 0;
  const res = await (await run(await makePackage(baseEvents().slice(1)), core)).write();
  assert.equal(res.counts.orphans, 1);
  assert.ok(!core.writes.includes('events.delete'));
});

test('[IMP11] review page: escaped, no script allowed, no folder path', async () => {
  const events = baseEvents();
  events[0].description = '<script>alert(1)</script>';
  const dir = await makePackage(events);
  const { n, report } = await run(dir, fakeCore());
  const html = renderReview(pack, report, n);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(!html.includes(dir), 'no absolute path');
  assert.ok(html.includes('../files/report.pdf#page=1'));
});
