import path from 'node:path';
import { localized, type DataModelPack } from '../dataModel/pack.ts';
import { modelPath } from '../tools/ensureStreams.ts';
import { normalizeDocumentUniqueId, documentUniqueIdKey, DOCUMENT_UNIQUE_ID_KEY } from '../dataModel/documentUniqueId.ts';
import { ATTACH_MAX_BYTES, DOCUMENT_EVENT_TYPE } from '../tools/attachFile.ts';
import { ALL_TIME } from '../tools/getEvents.ts';
import { readInside, type LoadedPackage } from './pkg.ts';
import type { Normalized, PkgEvent } from './inspect.ts';
import { canonical, resolveRefs } from './refs.ts';

/**
 * What the writer needs from the server: the batch call and the multipart upload of the connected session (so the
 * production-write gate, the timeouts and the error scrubbing of apiCall.ts apply). Injected for the tests.
 */
export interface Transport {
  batch (calls: Array<{ method: string; params: any }>): Promise<any[]>;
  upload (eventId: string, file: { name: string; mime: string; data: Buffer }): Promise<any>;
}

export interface Counts {
  created: number;
  updated: number;
  unchanged: number;
  /** in the account but trashed: the person removed it; never revived */
  trashed: number;
  /** a document already held under its identifier by another writer: linked, not duplicated */
  heldElsewhere: number;
  filesUploaded: number;
  /** in the account under this import's prefix, no longer in the package: reported, never deleted */
  orphans: number;
  failed: number;
}

export interface WriteError { code: string; line: number }
export interface WriteResult { counts: Counts; errors: WriteError[] }

/** A stop with a safe message (a code and fixed text), carrying what was done before it. */
export class ImportStop extends Error {
  code: string;
  errors: WriteError[];
  constructor (code: string, message: string, errors: WriteError[] = []) {
    super(message);
    this.code = code;
    this.errors = errors;
  }
}

const BATCH_MAX_CALLS = 100;
const BATCH_MAX_BYTES = 4 * 1024 * 1024;
const PAGE = 1000;
const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const PROVIDERS = ['provider/practitioner-v1', 'provider/organization-v1'];
const PROVIDER_KEYS = [
  { key: 'hdsGln', system: 'urn:oid:2.51.1.3' },
  { key: 'hdsZsr', system: 'urn:oid:2.16.756.5.30.1.123.100.2.1.1' }
];

const errorCode = (r: any): string => (typeof r?.error?.id === 'string' && /^[a-z0-9-]{1,60}$/.test(r.error.id)) ? r.error.id : 'failed';

/** Every event this import wrote, trashed ones included, by sourceKey (§ 5f.5). */
export async function readImport (t: Transport, tool: string): Promise<Map<string, any[]>> {
  const byKey = new Map<string, any[]>();
  for (let skip = 0; ; skip += PAGE) {
    const [res] = await t.batch([{
      method: 'events.get',
      params: { clientData: [{ path: 'sourceKey', prefix: tool + ':' }], state: 'all', ...ALL_TIME, limit: PAGE, skip }
    }]);
    if (res?.error || !Array.isArray(res?.events)) throw new ImportStop('account-read-failed', `Reading the account failed (${errorCode(res)}); nothing was written.`);
    for (const e of res.events) {
      const k = e?.clientData?.sourceKey;
      if (typeof k === 'string') byKey.set(k, [...(byKey.get(k) ?? []), e]);
    }
    if (res.events.length < PAGE) break;
  }
  return byKey;
}

/**
 * The document another writer already holds under this identifier (DOCUMENTS.md "A document already held"): the
 * oldest live one, else the oldest trashed one (left trashed). Stops on a failed read: creating then would duplicate.
 */
export async function findHeldDocument (t: Transport, docKey: string): Promise<any | null> {
  const [res] = await t.batch([{ method: 'events.get', params: { types: [DOCUMENT_EVENT_TYPE], clientData: [{ path: DOCUMENT_UNIQUE_ID_KEY, eq: docKey }], state: 'all', ...ALL_TIME, limit: 50 } }]);
  if (res?.error || !Array.isArray(res?.events)) throw new ImportStop('account-read-failed', `Looking a document up failed (${errorCode(res)}); stopped before writing it.`);
  const byAge = [...res.events].sort((a: any, b: any) => (a.created ?? 0) - (b.created ?? 0));
  return byAge.find((e: any) => !e.trashed) ?? byAge[0] ?? null;
}

/** Creates the model streams the package writes to that the account lacks, parents first (as ensure_streams). */
export async function ensureStreams (t: Transport, pack: DataModelPack, streamIds: string[]): Promise<number> {
  const [got] = await t.batch([{ method: 'streams.get', params: { state: 'all' } }]);
  if (got?.error) throw new ImportStop('account-read-failed', `Reading the account's streams failed (${errorCode(got)}); nothing was written.`);
  const existing = new Set<string>();
  const walk = (list: any[]) => { for (const s of list ?? []) { existing.add(s.id); walk(s.children); } };
  walk(got?.streams ?? []);
  const toCreate: Array<{ id: string; name: string; parentId: string | null }> = [];
  for (const id of new Set(streamIds)) {
    const p = modelPath((pack.streams ?? []) as any[], id) ?? [];
    p.forEach((s: any, i: number) => {
      if (existing.has(s.id)) return;
      existing.add(s.id);
      toCreate.push({ id: s.id, name: s.label ? localized(s.label, 'en') : (s.name ?? s.id), parentId: i === 0 ? null : p[i - 1].id });
    });
  }
  if (toCreate.length === 0) return 0;
  const results = await t.batch(toCreate.map((s) => ({ method: 'streams.create', params: s })));
  const failed = results.filter((r: any) => !r?.stream && r?.error?.id !== 'item-already-exists');
  if (failed.length > 0) {
    throw new ImportStop('streams-create-failed', `${failed.length} stream(s) could not be created (${errorCode(failed[0])}): check that connect covered every root import_inspect listed. Nothing else was written.`);
  }
  return toCreate.length;
}

/** The `clientData` the kit owns on one event, with the links of its content mirrored (DOCUMENTS.md, PROVENANCE.md). */
function wantedClientData (e: PkgEvent, content: any, ids: string[], stored: any, ownIds: Set<string>): Record<string, unknown> {
  const cd: Record<string, unknown> = { ...e.clientData, sourceKey: e.sourceKey };
  // related: written whole; links to this import's events not cited any more are dropped, other links kept
  const storedRelated = (stored?.clientData?.related && typeof stored.clientData.related === 'object') ? stored.clientData.related : {};
  const related: Record<string, true> = {};
  for (const id of Object.keys(storedRelated)) if (!ownIds.has(id)) related[id] = true;
  for (const id of ids) related[id] = true;
  if (Object.keys(related).length > 0 || stored?.clientData?.related != null) cd.related = related;
  if (e.type === DOCUMENT_EVENT_TYPE) {
    const id = normalizeDocumentUniqueId(content?.uniqueId);
    cd[DOCUMENT_UNIQUE_ID_KEY] = id ? documentUniqueIdKey(id) : null;
  }
  if (PROVIDERS.includes(e.type)) {
    for (const { key, system } of PROVIDER_KEYS) {
      const v = (content?.identifiers ?? []).find((i: any) => i?.system === system && typeof i.value === 'string')?.value;
      cd[key] = v ?? null;
    }
  }
  return cd;
}

/**
 * The fields of an update: only what differs from the stored event. Core semantics (mall eventsUtils): a duration is
 * stored as an end time and read back as `end - time`, absent when 0; `duration: null` means a running period, so a
 * duration is removed with 0; a description is removed with null; a null clientData value removes the key.
 */
function diff (stored: any, want: any): Record<string, unknown> | null {
  const update: Record<string, unknown> = {};
  for (const f of ['content', 'time', 'type']) if (canonical(stored[f] ?? null) !== canonical(want[f] ?? null)) update[f] = want[f];
  if (canonical(stored.streamIds ?? []) !== canonical(want.streamIds)) update.streamIds = want.streamIds;
  const storedDuration = typeof stored.duration === 'number' && stored.duration > 0 ? stored.duration : null;
  const read = want.duration == null ? 0 : (want.time + want.duration) - want.time;
  const wantDuration = read > 0 ? read : null;
  if (storedDuration == null ? wantDuration != null : (wantDuration == null || Math.abs(storedDuration - wantDuration) > 1e-6)) {
    update.duration = wantDuration ?? 0;
  }
  const storedDescription = typeof stored.description === 'string' && stored.description !== '' ? stored.description : null;
  if (storedDescription !== (want.description ?? null)) update.description = want.description ?? null;
  const cd: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(want.clientData)) {
    if (v === null) { if (stored.clientData?.[k] != null) cd[k] = null; continue; }
    if (canonical(stored.clientData?.[k] ?? null) !== canonical(v)) cd[k] = v;
  }
  if (Object.keys(cd).length > 0) update.clientData = cd;
  return Object.keys(update).length > 0 ? update : null;
}

function createParams (want: any): Record<string, unknown> {
  const p: Record<string, unknown> = { streamIds: want.streamIds, type: want.type, content: want.content, time: want.time };
  if (want.duration != null) p.duration = want.duration;
  if (want.description != null) p.description = want.description;
  const cd = Object.fromEntries(Object.entries(want.clientData).filter(([, v]) => v !== null));
  if (Object.keys(cd).length > 0) p.clientData = cd;
  return p;
}

function storedFile (ev: any): { size: number | null } | null {
  const a = Array.isArray(ev?.attachments) ? ev.attachments[0] : null;
  return a ? { size: typeof a.size === 'number' ? a.size : null } : null;
}

/** The event as the package wants it, its refs resolved. */
function wantedEvent (e: PkgEvent, idOf: Map<string, string>, stored: any, ownIds: Set<string>) {
  const content = resolveRefs(e.content, (k) => idOf.get(k) ?? 'unresolved');
  const ids = e.refs.map((k) => idOf.get(k)).filter((x): x is string => x != null);
  return { streamIds: e.streamIds, type: e.type, content, time: e.time, duration: e.duration, description: e.description, clientData: wantedClientData(e, content, ids, stored, ownIds) };
}

/**
 * Writes the package (§ 5f): the account is read first, every run, and is the truth; events go level by level
 * (sources first); a key absent is created, present is updated only when it differs, trashed is left. A document is
 * created, then its file uploaded; one without its file (a run cut short) gets it on the next run.
 */
export async function writePackage (
  pkg: LoadedPackage, pack: DataModelPack, n: Normalized, t: Transport,
  onProgress: (c: Counts, errors: WriteError[]) => void = () => {}
): Promise<WriteResult> {
  const tool = pkg.manifest!.tool;
  const counts: Counts = { created: 0, updated: 0, unchanged: 0, trashed: 0, heldElsewhere: 0, filesUploaded: 0, orphans: 0, failed: 0 };
  const errors: WriteError[] = [];
  const progress = () => onProgress({ ...counts }, [...errors]);
  const existing = await readImport(t, tool);
  for (const [, evs] of existing) {
    if (evs.length > 1) throw new ImportStop('account-duplicate-key', 'The account holds two events under one sourceKey of this import; nothing was written. Look at it with get_events (sourceKeyPrefix) before running again.');
  }
  await ensureStreams(t, pack, n.events.flatMap((e) => e.streamIds));
  const byKey = new Map(n.events.map((e) => [e.sourceKey, e]));
  const idOf = new Map<string, string>();
  const ownIds = new Set<string>();
  for (const [k, [ev]] of existing) { idOf.set(k, ev.id); ownIds.add(ev.id); }
  counts.orphans = [...existing.keys()].filter((k) => !byKey.has(k)).length;
  const uploads: Array<{ e: PkgEvent; id: string }> = [];
  const fileFor = (e: PkgEvent, ev: any, held = false) => {
    if (!e.attachment || ev.trashed) return;
    const f = storedFile(ev);
    if (f == null) uploads.push({ e, id: ev.id });
    else if (!held && f.size != null && f.size !== e.attachment.size) errors.push({ code: 'document-file-changed', line: e.line });
  };

  for (let li = 0; li < n.levels.length; li++) {
    const level = n.levels[li];
    const calls: Array<{ call: { method: string; params: any }; e: PkgEvent; kind: 'create' | 'update' }> = [];
    for (const key of level) {
      const e = byKey.get(key)!;
      const stored = existing.get(key)?.[0];
      const want = wantedEvent(e, idOf, stored, ownIds);
      if (stored) {
        if (stored.trashed === true) { counts.trashed++; continue; }
        const update = diff(stored, want);
        if (update) calls.push({ call: { method: 'events.update', params: { id: stored.id, update } }, e, kind: 'update' });
        else counts.unchanged++;
        fileFor(e, stored);
        continue;
      }
      const docKey = want.clientData[DOCUMENT_UNIQUE_ID_KEY];
      if (e.type === DOCUMENT_EVENT_TYPE && typeof docKey === 'string') {
        const held = await findHeldDocument(t, docKey);
        if (held) {
          idOf.set(key, held.id);
          counts.heldElsewhere++;
          fileFor(e, held, true);
          continue;
        }
      }
      calls.push({ call: { method: 'events.create', params: createParams(want) }, e, kind: 'create' });
    }

    for (const chunk of chunks(calls)) {
      const results = await t.batch(chunk.map((c) => c.call));
      chunk.forEach((c, i) => {
        const r = results[i];
        if (r?.event?.id) {
          if (c.kind === 'create') {
            counts.created++;
            idOf.set(c.e.sourceKey, r.event.id);
            ownIds.add(r.event.id);
            if (c.e.attachment) uploads.push({ e: c.e, id: r.event.id });
          } else {
            counts.updated++;
          }
        } else {
          counts.failed++;
          errors.push({ code: 'write-' + errorCode(r), line: c.e.line });
        }
      });
      progress();
    }
    // an event citing one that failed cannot be written with its link: stop before the next level
    const failedHere = level.filter((k) => !idOf.has(k)).length;
    if (failedHere > 0 && li < n.levels.length - 1) {
      throw new ImportStop('write-incomplete-level', `${failedHere} event(s) could not be written, so the events citing them were not written either. Check the errors, then run import_write again: it resumes.`, errors);
    }
  }

  for (const { e, id } of uploads) {
    try {
      if (!EVENT_ID_RE.test(id)) throw new Error('bad id');
      const data = await readInside(pkg.root, e.attachment!.rel, ATTACH_MAX_BYTES);
      await t.upload(id, { name: path.basename(e.attachment!.rel), mime: e.attachment!.mime, data });
      counts.filesUploaded++;
    } catch (err: any) {
      counts.failed++;
      const code = typeof err?.errorId === 'string' && /^[a-z0-9-]{1,60}$/.test(err.errorId) ? err.errorId : 'failed';
      errors.push({ code: 'upload-' + code, line: e.line });
    }
    progress();
  }
  return { counts, errors };
}

function * chunks<T extends { call: { params: any } }> (calls: T[]): Generator<T[]> {
  let cur: T[] = [];
  let bytes = 0;
  for (const c of calls) {
    const size = Buffer.byteLength(JSON.stringify(c.call));
    if (cur.length > 0 && (cur.length >= BATCH_MAX_CALLS || bytes + size > BATCH_MAX_BYTES)) {
      yield cur;
      cur = [];
      bytes = 0;
    }
    cur.push(c);
    bytes += size;
  }
  if (cur.length > 0) yield cur;
}

export interface VerifyResult {
  checked: number;
  missing: number;
  trashed: number;
  different: number;
  heldElsewhere: number;
  documentsWithoutFile: number;
  documentsFileChanged: number;
  orphans: number;
  duplicateKeys: number;
  differences: WriteError[];
}

/** Reads the import back and compares it with the package: counts and line numbers only. */
export async function verifyPackage (pkg: LoadedPackage, n: Normalized, t: Transport): Promise<VerifyResult> {
  const existing = await readImport(t, pkg.manifest!.tool);
  const r: VerifyResult = { checked: n.events.length, missing: 0, trashed: 0, different: 0, heldElsewhere: 0, documentsWithoutFile: 0, documentsFileChanged: 0, orphans: 0, duplicateKeys: 0, differences: [] };
  const idOf = new Map<string, string>();
  const ownIds = new Set<string>();
  for (const [k, evs] of existing) {
    if (evs.length > 1) r.duplicateKeys++;
    idOf.set(k, evs[0].id);
    ownIds.add(evs[0].id);
  }
  const byKey = new Map(n.events.map((e) => [e.sourceKey, e]));
  r.orphans = [...existing.keys()].filter((k) => !byKey.has(k)).length;
  const fileOf = (e: PkgEvent, ev: any, held = false) => {
    if (!e.attachment || ev.trashed) return;
    const f = storedFile(ev);
    if (f == null) {
      r.documentsWithoutFile++;
      r.differences.push({ code: 'document-without-file', line: e.line });
    } else if (!held && f.size != null && f.size !== e.attachment.size) {
      r.documentsFileChanged++;
      r.differences.push({ code: 'document-file-changed', line: e.line });
    }
  };
  for (const level of n.levels) {
    for (const key of level) {
      const e = byKey.get(key)!;
      const stored = existing.get(key)?.[0];
      if (!stored) {
        const id = e.type === DOCUMENT_EVENT_TYPE ? normalizeDocumentUniqueId((e.content as any)?.uniqueId) : null;
        const held = id ? await findHeldDocument(t, documentUniqueIdKey(id)) : null;
        if (held) { idOf.set(key, held.id); r.heldElsewhere++; fileOf(e, held, true); continue; }
        r.missing++;
        r.differences.push({ code: 'missing', line: e.line });
        continue;
      }
      if (stored.trashed) { r.trashed++; continue; }
      if (diff(stored, wantedEvent(e, idOf, stored, ownIds))) { r.different++; r.differences.push({ code: 'different', line: e.line }); }
      fileOf(e, stored);
    }
  }
  return r;
}
