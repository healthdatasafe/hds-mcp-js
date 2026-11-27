import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DataModelPack } from '../src/dataModel/pack.ts';
import { documentStreamsProblem, filingNote, isDocumentsStream, kindOfContent, streamForKind } from '../src/dataModel/documentStreams.ts';

// plan 144: an assistant writes a document on `documents` only; filing in a class (data-model 4.35.0) is hers

const C = (code: string, system = 'http://snomed.info/sct') => ({ system, code });
const pack: DataModelPack = {
  items: {},
  streams: [
    { id: 'documents', name: 'Medical documents', children: [{ id: 'documents-clinical', label: { en: 'Clinical documents' } }, { id: 'documents-admin', label: { en: 'Administrative documents' }, children: [{ id: 'documents-admin-insurance', label: { en: 'Insurance documents' } }] }] },
    { id: 'body', children: [{ id: 'body-weight' }] }
  ],
  documentKinds: {
    kinds: {
      'laboratory-report': { class: C('1'), type: C('2'), stream: 'documents-clinical' },
      'other-patient-record': { class: C('3'), type: C('4'), stream: 'documents-clinical' },
      'administrative-document': { class: C('5'), type: C('6'), stream: 'documents-admin' },
      'access-log': { class: C('7'), type: C('8') },
      ghost: { class: C('9'), type: C('10'), stream: 'documents-restricted' }
    },
    detailKinds: { 'menstrual-cycle-chart': { class: C('3'), type: C('4'), detail: C('cyc', 'https://hds'), stream: 'documents-admin' } }
  }
};

test('[DST1] kindOfContent: class + type[0], a detail kind when a type Coding names it; Codings carry their system', () => {
  assert.equal(kindOfContent(pack, { class: { code: '1' }, type: [{ code: '2' }] }), null, 'no system');
  assert.equal(kindOfContent(pack, { class: C('1'), type: [C('2')] }), 'laboratory-report');
  assert.equal(kindOfContent(pack, { class: C('3'), type: [C('4')] }), 'other-patient-record');
  assert.equal(kindOfContent(pack, { class: C('3'), type: [C('4'), C('cyc', 'https://hds')] }), 'menstrual-cycle-chart');
  assert.equal(kindOfContent(pack, { class: C('1'), type: [C('2', 'http://other')] }), null, 'system differs');
  assert.equal(kindOfContent(pack, { class: C('1'), type: C('2') }), null, 'type must be an array');
  assert.equal(kindOfContent(pack, { title: 'no codes' }), null);
  assert.equal(kindOfContent(pack, null), null);
});

test('[DST2] streamForKind: the class her app proposes, the root when none or unknown to the model', () => {
  assert.equal(streamForKind(pack, 'laboratory-report'), 'documents-clinical');
  assert.equal(streamForKind(pack, 'menstrual-cycle-chart'), 'documents-admin');
  assert.equal(streamForKind(pack, 'access-log'), 'documents');
  assert.equal(streamForKind(pack, 'ghost'), 'documents', 'a stream the model lacks');
  assert.equal(streamForKind(pack, 'unknown'), 'documents');
  assert.equal(streamForKind(pack, null), 'documents');
});

test('[DST3] isDocumentsStream: the model tree, and a documents-… id an older pack does not know', () => {
  assert.equal(isDocumentsStream(pack, 'documents'), true);
  assert.equal(isDocumentsStream(pack, 'documents-admin-insurance'), true);
  assert.equal(isDocumentsStream(pack, 'documents-restricted'), true);
  assert.equal(isDocumentsStream(pack, 'body-weight'), false);
  assert.equal(isDocumentsStream(pack, 'share-abc'), false);
});

test('[DST4] documentStreamsProblem: a new document on ["documents"] alone', () => {
  assert.equal(documentStreamsProblem(pack, ['documents']), null);
  for (const ids of [['documents-clinical'], ['documents', 'documents-admin-insurance'], ['documents-restricted']]) {
    assert.match(documentStreamsProblem(pack, ids)!, /on stream "documents" alone, not on "documents-.*filing and sharing/, ids.join());
  }
  for (const ids of [['documents', 'share-x'], ['share-x', 'documents'], ['body-weight'], ['documents', 'body-weight']]) {
    assert.match(documentStreamsProblem(pack, ids)!, /on stream "documents" alone: filing and sharing/, ids.join());
  }
});

test('[DST5] filingNote: not filed, and the class the person can file it in', () => {
  assert.match(filingNote(pack, { class: C('1'), type: [C('2')] }), /^Not filed: .*file it under "Clinical documents" in their HDS app/);
  assert.equal(filingNote(pack, { class: C('7'), type: [C('8')] }), 'Not filed: it is on "documents", where its kind stays.');
  assert.equal(filingNote(pack, { title: 'x' }), 'Not filed: it is on "documents".');
});
