import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUIDES } from '../src/guides/content.ts';

// LOINC check digit (mod 10, as hds-lib checkLabResultCoded and loinc-db compute it).
function loincCheckDigitOk (code: string): boolean {
  const m = /^(\d+)-(\d)$/.exec(code);
  if (!m) return false;
  const digits = m[1].split('').map(Number).reverse();
  let sum = 0;
  digits.forEach((d, i) => {
    if (i % 2 === 0) {
      const x = d * 2;
      sum += x > 9 ? x - 9 : x;
    } else {
      sum += d;
    }
  });
  return (10 - (sum % 10)) % 10 === Number(m[2]);
}

test('lab-report guide: the verified coded-fallback table (data-model 4.30.0)', () => {
  const guide = GUIDES['lab-report'];
  const start = guide.indexOf('- Verified codes for the coded fallback');
  assert.ok(start > 0, 'table present');
  const table = guide.slice(start, guide.indexOf('- Counts printed per mm3', start));
  const codes = table.match(/\b\d{4,5}-\d\b/g) ?? [];
  assert.equal(codes.length, 27);
  assert.equal(new Set(codes).size, 27, 'each code once');
  for (const c of codes) assert.ok(loincCheckDigitOk(c), `${c}: check digit`);
  assert.ok(!loincCheckDigitOk('8101-0'), 'the check rejects a wrong digit');
});

test('missing-item guide: the profile summary lines are decided, not gaps', () => {
  const guide = GUIDES['missing-item'].replace(/\s+/g, ' ');
  for (const s of ['emergency contacts', 'trusted person', 'advance-directive', 'organ-donor-card']) {
    assert.ok(guide.includes(s), s);
  }
});
