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
import { importInspectHandler, importReviewHandler, importWriteHandler, importStatusHandler, importCleanupHandler, setImportTestHooks } from '../src/import/tools.ts';
import { setApiEndpoint, clearApiEndpoint } from '../src/auth/session.ts';

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
  const streams = new Set<string>();
  const matches = (e: any, p: any) => (p.types == null || p.types.includes(e.type)) &&
    (p.state === 'all' || !e.trashed) &&
    (p.clientData ?? []).every((c: any) => {
      const v = c.path.split('.').reduce((o: any, k: string) => o?.[k], e.clientData);
      return c.prefix != null ? (typeof v === 'string' && v.startsWith(c.prefix)) : c.eq != null ? v === c.eq : c.exists ? v != null : true;
    });
  const t: Transport = {
    batch: async (calls) => calls.map((c) => {
      if (c.method === 'streams.get') return { streams: [...streams].map((id) => ({ id })) };
      if (c.method === 'streams.create') { writes.push('streams.create'); streams.add(c.params.id); return { stream: c.params }; }
      if (c.method === 'events.get') {
        const all = [...events.values()].filter((e) => matches(e, c.params));
        return { events: structuredClone(all.slice(c.params.skip ?? 0, (c.params.skip ?? 0) + (c.params.limit ?? 20))) };
      }
      writes.push(c.method);
      if (c.method === 'events.create') {
        const e = { ...structuredClone(c.params), id: `ev${++n}`, created: n };
        if (e.duration === 0) delete e.duration;
        events.set(e.id, e);
        return { event: structuredClone(e) };
      }
      if (c.method === 'events.update') {
        const e = events.get(c.params.id);
        if (!e) return { error: { id: 'unknown-resource' } };
        const { clientData, ...rest } = c.params.update;
        Object.assign(e, structuredClone(rest));
        if (rest.duration === 0) delete e.duration;
        if (rest.description === null) delete e.description;
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
  return { pkg, n, report: buildReport(pkg, pack, n), write: () => writePackage(pkg, pack, n, core.t), verify: () => verifyPackage(pkg, n, core.t) };
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
    { sourceKey: 'testkit:d:6', itemKey: 'document', content: { title: 't' }, time: T0, attachment: '../outside.pdf' },
    { sourceKey: 'testkit:d:7', itemKey: 'document', content: { title: 't' }, time: T0, attachment: 'files/../../outside.pdf' }
  ], { files: { 'files/report.pdf': PDF, 'files/fake.pdf': Buffer.from('not a pdf') } });
  const { report } = await run(dir, fakeCore());
  const codes = report.problems.map((p) => `${p.line}:${p.code}`);
  for (const c of ['2:sourcekey-duplicate', '3:time-missing', '4:time-out-of-range', '5:sourcekey-tool', '6:content-invalid',
    '7:clientdata-reserved-key', '8:ref-dangling', '9:attachment-missing', '10:ref-cycle', '11:ref-cycle', '12:attachment-format',
    '13:attachment-not-in-files', '14:attachment-file-path-outside']) {
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
  assert.equal(core.writes.filter((w) => w === 'streams.create').length, 5, 'body, body-weight, encounter, encounter-providers, documents: parents first');
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
  assert.deepEqual(await r.verify(), { checked: 3, missing: 0, trashed: 0, different: 0, heldElsewhere: 0, documentsWithoutFile: 0, documentsFileChanged: 0, orphans: 0, duplicateKeys: 0, differences: [] });
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

test('[IMP12] a symbolic link a package ships in .hds-import is replaced, never followed', async () => {
  const dir = await makePackage(baseEvents());
  const outside = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'hds-outside-')), 'victim.txt');
  await fsp.writeFile(outside, 'untouched');
  await fsp.mkdir(path.join(dir, '.hds-import'));
  await fsp.symlink(outside, path.join(dir, '.hds-import', 'report.json'));
  setImportTestHooks({ pack, transport: null, open: async () => {} });
  await importInspectHandler({ packagePath: dir });
  assert.equal(await fsp.readFile(outside, 'utf8'), 'untouched');
  assert.ok((await fsp.lstat(path.join(dir, '.hds-import', 'report.json'))).isFile());
});

test('[IMP13] a .hds-import that is a symbolic link is refused, nothing written', async () => {
  const dir = await makePackage(baseEvents());
  const elsewhere = await fsp.mkdtemp(path.join(os.tmpdir(), 'hds-elsewhere-'));
  await fsp.symlink(elsewhere, path.join(dir, '.hds-import'));
  setImportTestHooks({ pack, transport: null, open: async () => {} });
  await assert.rejects(importInspectHandler({ packagePath: dir }), /kit-dir-invalid/);
  assert.deepEqual(await fsp.readdir(elsewhere), []);
});

test('[IMP14] errors never carry the folder path; a non-package folder gets no .hds-import', async () => {
  const dir = await makePackage(baseEvents());
  await fsp.chmod(path.join(dir, 'events.jsonl'), 0o000);
  setImportTestHooks({ pack, transport: null, open: async () => {} });
  const r = await importInspectHandler({ packagePath: dir });
  assert.ok(!JSON.stringify(r).includes(dir), 'no path in the answer');
  await fsp.chmod(path.join(dir, 'events.jsonl'), 0o600);
  const plain = await fsp.mkdtemp(path.join(os.tmpdir(), 'hds-plain-'));
  await importInspectHandler({ packagePath: plain });
  assert.deepEqual(await fsp.readdir(plain), [], 'nothing written in a folder that is not a package');
  await assert.rejects(importCleanupHandler({ packagePath: plain }), /not an import package/);
});

test('[IMP15] import_write: only what was reviewed, never twice at once', async () => {
  const core = fakeCore();
  const dir = await makePackage(baseEvents());
  setImportTestHooks({ pack, transport: core.t, open: async () => {} });
  setApiEndpoint('https://tok@demo-user.demo.datasafe.dev/');
  try {
    await assert.rejects(importWriteHandler({ packagePath: dir, confirm: true }), /not reviewed/);
    await importReviewHandler({ packagePath: dir });
    const [a, b] = await Promise.allSettled([importWriteHandler({ packagePath: dir, confirm: true }), importWriteHandler({ packagePath: dir, confirm: true })]);
    assert.equal([a, b].filter((x) => x.status === 'fulfilled').length, 1);
    assert.match(String((b as PromiseRejectedResult).reason ?? (a as PromiseRejectedResult).reason), /already running/);
    for (let i = 0; i < 50 && /running|starting/.test((await importStatusHandler({})).content[0].text); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match((await importStatusHandler({})).content[0].text, /done/);
    assert.equal(core.events.size, 3);
    // a change after the review: refused until reviewed again
    await fsp.appendFile(path.join(dir, 'events.jsonl'), JSON.stringify({ sourceKey: 'testkit:weight:2', itemKey: 'body-weight', content: 71, time: T0 }) + '\n');
    await assert.rejects(importWriteHandler({ packagePath: dir, confirm: true }), /not reviewed/);
  } finally {
    clearApiEndpoint();
    setImportTestHooks({ pack: null, transport: null, open: null });
  }
});

test('[IMP16] a document held elsewhere: verify is clean, and a failed lookup stops instead of duplicating', async () => {
  const core = fakeCore();
  await core.t.batch([{ method: 'events.create', params: { streamIds: ['documents'], type: 'file/xds-v1', time: T0, content: { title: 'From the EPR' }, clientData: { sourceKey: 'epr:doc:9', hdsDocumentUniqueId: 'urn:ietf:rfc:3986|urn:oid:2.999.1' } } }]);
  const r = await run(await makePackage(baseEvents()), core);
  await r.write();
  const v = await r.verify();
  assert.equal(v.heldElsewhere, 1);
  assert.equal(v.missing + v.different, 0, JSON.stringify(v.differences));
  const failing = fakeCore();
  const t = { ...failing.t, batch: async (calls: any[]) => calls.some((c) => c.params?.clientData?.[0]?.path === 'hdsDocumentUniqueId') ? [{ error: { id: 'forbidden' } }] : failing.t.batch(calls) };
  const r2 = await run(await makePackage(baseEvents()), failing);
  await assert.rejects(writePackage(r2.pkg, pack, r2.n, t), /Looking a document up failed/);
  assert.equal([...failing.events.values()].filter((e) => e.type === 'file/xds-v1').length, 0);
});

test('[IMP17] duration and description follow the core: removed with 0 and null, a re-run writes nothing', async () => {
  const core = fakeCore();
  const events = baseEvents();
  (events[0] as any).duration = 3600.5;
  await (await run(await makePackage(events), core)).write();
  core.writes.length = 0;
  await (await run(await makePackage(events), core)).write();
  assert.deepEqual(core.writes, [], 'a fractional duration compares equal');
  delete (events[0] as any).duration;
  delete (events[0] as any).description;
  const r = await run(await makePackage(events), core);
  core.writes.length = 0;
  await r.write();
  const weight = [...core.events.values()].find((e) => e.type === 'mass/kg');
  assert.equal(weight.duration, undefined, 'removed with 0, not null (a running period)');
  assert.equal(weight.description, undefined);
  core.writes.length = 0;
  (events[0] as any).duration = 0;
  await (await run(await makePackage(events), core)).write();
  assert.deepEqual(core.writes, [], 'duration 0 is none');
});

test('[IMP18] package strings are echoed only when they are plain identifiers', async () => {
  const dir = await makePackage([
    { sourceKey: 'testkit:w:1', itemKey: 'Mrs Doe <diabetes>', content: 70, time: T0 },
    { sourceKey: 'testkit:w:2', itemKey: 'body-weight', content: 70, time: T0, [`${SECRET}`]: 1 },
    { sourceKey: 'testkit:w:3', itemKey: 'body-weight', content: 70, time: T0, clientData: JSON.parse('{"__proto__": {"x": 1}}') }
  ]);
  const { report } = await run(dir, fakeCore());
  const s = JSON.stringify(report);
  assert.ok(!s.includes('Doe') && !s.includes(SECRET));
  assert.ok(report.problems.some((p) => p.code === 'key-forbidden' && p.line === 3));
});

test('[IMP19] a stop keeps its errors for import_status', async () => {
  const core = fakeCore();
  const t = { ...core.t, batch: async (calls: any[]) => calls.some((c) => c.method === 'events.create' && c.params.type === 'provider/practitioner-v1') ? calls.map(() => ({ error: { id: 'forbidden' } })) : core.t.batch(calls) };
  const r = await run(await makePackage(baseEvents()), core);
  const err = await writePackage(r.pkg, pack, r.n, t).catch((e) => e);
  assert.equal(err.code, 'write-incomplete-level');
  assert.deepEqual(err.errors.map((x: any) => x.line).sort(), [1, 2], 'the failed batch, by line');
  assert.ok(err.errors.every((x: any) => x.code === 'write-forbidden'));
});

test('[IMP20] a document whose file changed under the same key is reported, not overwritten', async () => {
  const core = fakeCore();
  const dir = await makePackage(baseEvents());
  await (await run(dir, core)).write();
  await fsp.writeFile(path.join(dir, 'files/report.pdf'), Buffer.concat([PDF, Buffer.from('more bytes')]));
  const r = await run(dir, core);
  const res = await r.write();
  assert.deepEqual(res.errors, [{ code: 'document-file-changed', line: 3 }]);
  assert.equal((await r.verify()).documentsFileChanged, 1);
});
