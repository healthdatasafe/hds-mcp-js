import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemCodes, formatCodes } from '../src/dataModel/codes.ts';
import { scoreItem } from '../src/tools/searchItems.ts';
import { resolveEndpoint } from '../src/dataModel/datasources.ts';
import { localized } from '../src/dataModel/pack.ts';
import type { ItemDef } from '../src/dataModel/pack.ts';

const glucose: ItemDef = {
  streamId: 'body-blood-serum-glucose-fasting',
  type: 'number',
  label: { en: 'Fasting glucose', fr: 'Glycémie à jeun' },
  references: { snomed: ['271062006'] },
  variations: {
    eventType: {
      options: [
        { value: 'concentration/mg-dl', loinc: '1558-6' },
        { value: 'concentration/mmol-l', loinc: '14771-0' }
      ]
    }
  },
  fhir: { code: { system: 'http://loinc.org', code: '1558-6' }, alsoMatch: [{ system: 'urn:other', code: 'x' }] }
} as unknown as ItemDef;

test('itemCodes: references, per-unit LOINC and FHIR code, unit form kept, unknown systems dropped', () => {
  assert.deepEqual(itemCodes(glucose), [
    { system: 'SNOMED-CT', code: '271062006' },
    { system: 'LOINC', code: '1558-6', eventType: 'concentration/mg-dl' },
    { system: 'LOINC', code: '14771-0', eventType: 'concentration/mmol-l' }
  ]);
  assert.match(formatCodes(itemCodes(glucose)), /^SNOMED-CT 271062006, LOINC 1558-6 \(concentration\/mg-dl\)/);
});

test('itemCodes: fhir codings and alsoMatch keyed by eventType, loincMethod, icf', () => {
  const ldl = {
    streamId: 'x',
    type: 'number',
    references: { loincMethod: ['104620-0'], icf: ['d450'] },
    fhir: {
      code: { from: 'eventType', codings: { 'concentration/mg-dl': { system: 'http://loinc.org', code: '2089-1' } } },
      alsoMatch: { 'concentration/mg-dl': [{ system: 'http://loinc.org', code: '13457-7' }] }
    }
  } as unknown as ItemDef;
  assert.deepEqual(itemCodes(ldl), [
    { system: 'LOINC', code: '104620-0' },
    { system: 'ICF', code: 'd450' },
    { system: 'LOINC', code: '2089-1', eventType: 'concentration/mg-dl' },
    { system: 'LOINC', code: '13457-7', eventType: 'concentration/mg-dl' }
  ]);
});

test('itemCodes: fhir with a null code does not throw', () => {
  assert.deepEqual(itemCodes({ streamId: 'x', type: 'number', fhir: { code: null, alsoMatch: null } } as unknown as ItemDef), []);
});

test('scoreItem: a LOINC code finds the item that owns it', () => {
  assert.ok(scoreItem('body-blood-serum-glucose-fasting', glucose, '14771-0') >= 90);
  assert.equal(scoreItem('body-blood-serum-glucose-fasting', glucose, '9999-9'), 0);
});

test('scoreItem: French labels match', () => {
  assert.ok(scoreItem('body-blood-serum-glucose-fasting', glucose, 'glycémie') > 0);
});

test('localized: falls back to English, then any locale', () => {
  assert.equal(localized({ en: 'a', fr: 'b' }, 'fr'), 'b');
  assert.equal(localized({ en: 'a' }, 'de'), 'a');
  assert.equal(localized({ fr: 'b' }, 'de'), 'b');
  assert.equal(localized(undefined, 'fr'), '');
});

test('resolveEndpoint: an http endpoint is used as is', async () => {
  assert.equal(await resolveEndpoint('https://example.org/x'), 'https://example.org/x');
});
