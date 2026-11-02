import type { ItemDef } from './pack.ts';

export interface ItemCode {
  system: 'LOINC' | 'SNOMED-CT' | 'ICD-10' | 'ICF';
  code: string;
  // The unit variation (eventType) a per-unit code belongs to.
  eventType?: string;
}

const REFERENCE_SYSTEMS: Record<string, ItemCode['system']> = {
  loinc: 'LOINC',
  // Method-specific LOINC codes: owned by the item (data-model BLOOD-CHEMISTRY.md), never exported.
  loincMethod: 'LOINC',
  snomed: 'SNOMED-CT',
  icd10: 'ICD-10',
  icf: 'ICF'
};

const FHIR_SYSTEMS: Record<string, ItemCode['system']> = {
  'http://loinc.org': 'LOINC',
  'http://snomed.info/sct': 'SNOMED-CT'
};

interface Coding { system?: string; code?: string }

function asArray<T> (v: T | T[] | null | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Every terminology code an item carries: `references.*`, per-unit
 * `variations.eventType.options[].loinc`, and `fhir.code` / `fhir.alsoMatch`, each either
 * plain or keyed by eventType. Deduplicated; a code also listed for a unit keeps only its unit form.
 */
export function itemCodes (item: ItemDef): ItemCode[] {
  const out: ItemCode[] = [];
  const refs = (item.references ?? {}) as Record<string, string[] | string>;
  for (const [key, codes] of Object.entries(refs)) {
    const system = REFERENCE_SYSTEMS[key];
    if (system) for (const code of asArray(codes)) out.push({ system, code });
  }
  for (const o of item.variations?.eventType?.options ?? []) {
    if (o.loinc) out.push({ system: 'LOINC', code: o.loinc, eventType: o.value });
  }
  const pushFhir = (c: Coding | undefined, eventType?: string) => {
    const system = c?.system ? FHIR_SYSTEMS[c.system] : undefined;
    if (system && c?.code) out.push({ system, code: c.code, eventType });
  };
  const fhir = (item.fhir ?? {}) as {
    code?: (Coding & { codings?: Record<string, Coding> }) | null;
    alsoMatch?: Coding[] | Record<string, Coding[] | Coding> | null;
  };
  if (fhir.code?.codings) {
    for (const [eventType, c] of Object.entries(fhir.code.codings)) pushFhir(c, eventType);
  } else if (fhir.code) {
    pushFhir(fhir.code);
  }
  if (Array.isArray(fhir.alsoMatch)) {
    for (const c of fhir.alsoMatch) pushFhir(c);
  } else if (fhir.alsoMatch) {
    for (const [eventType, cs] of Object.entries(fhir.alsoMatch)) {
      for (const c of asArray(cs)) pushFhir(c, eventType);
    }
  }
  const perUnit = new Set(out.filter((c) => c.eventType).map((c) => `${c.system}|${c.code}`));
  const seen = new Set<string>();
  return out.filter((c) => {
    if (!c.eventType && perUnit.has(`${c.system}|${c.code}`)) return false;
    const k = `${c.system}|${c.code}|${c.eventType ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function formatCodes (codes: ItemCode[]): string {
  return codes.map((c) => `${c.system} ${c.code}${c.eventType ? ` (${c.eventType})` : ''}`).join(', ');
}
