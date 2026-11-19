// References between the events of one package: `{ "$ref": "<sourceKey>" }` wherever an event id is expected
// (content `supersedes[]`, `authors[].eventId`, `encounterId`, …), resolved to the written event's id by the kit.

export function isRef (v: unknown): v is { $ref: string } {
  return v != null && typeof v === 'object' && !Array.isArray(v) &&
    Object.keys(v).length === 1 && typeof (v as any).$ref === 'string';
}

/** Every `$ref` key in `value`, in order, with repeats. */
export function collectRefs (value: unknown, out: string[] = []): string[] {
  if (isRef(value)) {
    out.push(value.$ref);
  } else if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, out);
  } else if (value != null && typeof value === 'object') {
    for (const v of Object.values(value)) collectRefs(v, out);
  }
  return out;
}

/** A copy of `value` with each `$ref` replaced by `idOf(key)`. */
export function resolveRefs (value: unknown, idOf: (key: string) => string): unknown {
  if (isRef(value)) return idOf(value.$ref);
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, idOf));
  if (value != null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveRefs(v, idOf);
    return out;
  }
  return value;
}

/**
 * The keys in dependency order, in levels (an event comes after every event it cites), or the keys left in a cycle.
 * `deps` lists, per key, the package keys it cites; keys outside the package are ignored here (dangling, reported
 * apart).
 */
export function dependencyLevels (deps: Map<string, string[]>): { levels: string[][]; cycle: string[] } {
  const remaining = new Map<string, Set<string>>();
  for (const [k, ds] of deps) remaining.set(k, new Set(ds.filter((d) => d !== k && deps.has(d))));
  const self = [...deps].filter(([k, ds]) => ds.includes(k)).map(([k]) => k);
  const levels: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, ds]) => ds.size === 0).map(([k]) => k);
    if (ready.length === 0) break;
    levels.push(ready);
    for (const k of ready) remaining.delete(k);
    for (const ds of remaining.values()) for (const k of ready) ds.delete(k);
  }
  return { levels, cycle: [...new Set([...self, ...remaining.keys()])] };
}

/** JSON with sorted object keys, for comparing stored and wanted values. */
export function canonical (value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys (v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v != null && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as any)[k])]));
  }
  return v;
}
