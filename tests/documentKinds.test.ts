import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDocumentUniqueId, documentUniqueIdKey } from '../src/dataModel/documentUniqueId.ts';
import { eventsGetParams, ALL_TIME } from '../src/tools/getEvents.ts';

// Document kinds (data-model 4.17.0) and the "document already held" lookup (B-2026-11-18-4).

const URI = 'urn:ietf:rfc:3986';

test('normalizeDocumentUniqueId: one spelling for an OID or a UUID, as hds-lib 2.55.1', () => {
  assert.deepEqual(normalizeDocumentUniqueId('2.999.1.2.3'), { system: URI, value: 'urn:oid:2.999.1.2.3' });
  assert.deepEqual(normalizeDocumentUniqueId(' URN:OID:2.999.1 '), { system: URI, value: 'urn:oid:2.999.1' });
  assert.deepEqual(normalizeDocumentUniqueId('urn:uuid:6F1E3C2A-8B4D-4E5F-9A0B-1C2D3E4F5A6B'),
    { system: URI, value: 'urn:uuid:6f1e3c2a-8b4d-4e5f-9a0b-1c2d3e4f5a6b' });
  assert.deepEqual(normalizeDocumentUniqueId({ system: 'URN:IETF:RFC:3986', value: '2.999.7' }), { system: URI, value: 'urn:oid:2.999.7' });
  assert.deepEqual(normalizeDocumentUniqueId({ system: ' https://example.org/docs ', value: ' A-17 ' }), { system: 'https://example.org/docs', value: 'A-17' });
});

test('normalizeDocumentUniqueId: null for what no document stores', () => {
  for (const id of ['2.999.1^ext', 'not-an-oid', '', { system: 'urn:oid:2.999', value: 'x' }, { value: 'x' },
    { system: 'https://e.org', value: '  ' }, { system: 'https://e.org', value: 'a' + String.fromCharCode(0x2028) + 'b' }, { system: URI, value: 'x' },
    { system: 'no scheme', value: 'x' }, { system: 'https://e.org|x', value: 'x' }, null, 42, ['2.999']]) {
    assert.equal(normalizeDocumentUniqueId(id), null, JSON.stringify(id));
  }
  assert.equal(documentUniqueIdKey({ system: URI, value: 'urn:oid:2.999' }), 'urn:ietf:rfc:3986|urn:oid:2.999');
});

test('eventsGetParams: documentUniqueId is matched on hdsDocumentUniqueId, whole time range', () => {
  assert.deepEqual(eventsGetParams({ types: ['file/xds-v1'], documentUniqueId: 'urn:oid:2.999.1', state: 'all' }), {
    limit: 100,
    types: ['file/xds-v1'],
    state: 'all',
    clientData: [{ path: 'hdsDocumentUniqueId', eq: 'urn:ietf:rfc:3986|urn:oid:2.999.1' }],
    fromTime: ALL_TIME.fromTime,
    toTime: ALL_TIME.toTime
  });
  assert.throws(() => eventsGetParams({ documentUniqueId: '2.999.1^42' }), /not an identifier a document stores/);
});

const pack = {
  version: '4.17.0',
  items: {},
  documentKinds: {
    source: { version: '3.4.0' },
    kinds: {
      'laboratory-report': {
        label: { en: 'Laboratory report', fr: 'Rapport de laboratoire', de: 'Laborbericht', it: 'Referto di laboratorio' },
        description: { en: 'The results of laboratory tests.', fr: 'Les résultats.' },
        class: { system: 'http://snomed.info/sct', code: '371525003', display: 'Clinical procedure report' },
        type: { system: 'http://snomed.info/sct', code: '4241000179101', display: 'Laboratory report' },
        timeBasis: 'service'
      },
      'imaging-order': {
        label: { en: 'Imaging order', fr: "Demande d'imagerie" },
        description: { en: 'A request for an imaging examination.', fr: 'Une demande.' },
        class: { system: 'http://snomed.info/sct', code: '721963009', display: 'Order document' },
        type: { system: 'http://snomed.info/sct', version: 'http://snomed.info/sct/2011000195101', code: '2161000195103', display: 'Imaging order' },
        timeBasis: 'creation'
      },
      gone: {
        label: { en: 'Gone', fr: 'Parti' },
        description: { en: 'x', fr: 'x' },
        class: { system: 'http://snomed.info/sct', code: '1', display: 'x' },
        type: { system: 'http://snomed.info/sct', code: '2', display: 'x' },
        timeBasis: 'creation',
        deprecated: true
      },
      'other-patient-record': {
        label: { en: 'Other patient record', fr: 'Autre dossier' },
        description: { en: 'x', fr: 'x' },
        class: { system: 'http://snomed.info/sct', code: '184216000', display: 'Patient record type' },
        type: { system: 'http://snomed.info/sct', code: '419891008', display: 'Record artifact' },
        timeBasis: 'creation'
      }
    },
    detailKinds: {
      'menstrual-cycle-chart': {
        label: { en: 'Menstrual cycle chart', fr: 'Tableau de cycle menstruel' },
        description: { en: 'A day-by-day chart.', fr: 'Un tableau.' },
        class: { system: 'http://snomed.info/sct', code: '184216000', display: 'Patient record type' },
        type: { system: 'http://snomed.info/sct', code: '419891008', display: 'Record artifact' },
        detail: { system: 'https://hds.ngo/fhir/CodeSystem/document-kind', code: 'menstrual-cycle-chart', display: 'Menstrual cycle chart' },
        timeBasis: 'creation'
      }
    }
  }
};

test('list_document_kinds: the list, one kind\'s Codings, unknown key', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(pack), { status: 200 }));
  const { listDocumentKindsHandler } = await import('../src/tools/listDocumentKinds.ts');
  const list = (await listDocumentKindsHandler({})).content[0].text;
  assert.match(list, /CH Term 3\.4\.0/);
  assert.match(list, /\*\*laboratory-report\*\* — Laboratory report \(fr Rapport de laboratoire, de Laborbericht, it Referto di laboratorio\)/);
  assert.match(list, /type 2161000195103 Imaging order \[Swiss extension\] · timeBasis creation/);
  assert.doesNotMatch(list, /\*\*gone\*\*/);
  const one = await listDocumentKindsHandler({ key: 'imaging-order' });
  assert.match(one.content[0].text, /timeBasis creation/);
  assert.deepEqual(JSON.parse(one.content[1].text.replace(/```json\n|\n```/g, '')), {
    class: pack.documentKinds.kinds['imaging-order'].class,
    type: pack.documentKinds.kinds['imaging-order'].type
  });
  assert.match((await listDocumentKindsHandler({ key: 'gone' })).content[0].text, /Deprecated/);
  await assert.rejects(listDocumentKindsHandler({ key: 'nope' }), /Unknown document kind "nope"/);
});

test('list_document_kinds: a detail kind (4.32.0) is listed after its kind and gives its detail Coding', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(pack), { status: 200 }));
  const { listDocumentKindsHandler } = await import('../src/tools/listDocumentKinds.ts');
  const list = (await listDocumentKindsHandler({})).content[0].text;
  assert.ok(list.indexOf('**other-patient-record**') < list.indexOf('**menstrual-cycle-chart**'));
  assert.match(list, /type 419891008 Record artifact \+ detail menstrual-cycle-chart · timeBasis creation/);
  const one = await listDocumentKindsHandler({ key: 'menstrual-cycle-chart' });
  assert.match(one.content[0].text, /detail as content\.type\[1\]/);
  const k = pack.documentKinds.detailKinds['menstrual-cycle-chart'];
  assert.deepEqual(JSON.parse(one.content[1].text.replace(/```json\n|\n```/g, '')), { class: k.class, type: k.type, detail: k.detail });
  const plain = await listDocumentKindsHandler({ key: 'other-patient-record' });
  assert.doesNotMatch(plain.content[0].text, /detail/);
});
