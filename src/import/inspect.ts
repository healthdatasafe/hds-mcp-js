import path from 'node:path';
import type { DataModelPack } from '../dataModel/pack.ts';
import { contentErrors, itemEventTypes, optionProblem } from '../dataModel/eventTypes.ts';
import { normalizeDocumentUniqueId, DOCUMENT_UNIQUE_ID_KEY } from '../dataModel/documentUniqueId.ts';
import { DOCUMENTS_ROOT, documentStreamsProblem } from '../dataModel/documentStreams.ts';
import { ATTACH_MAX_BYTES, DOCUMENT_EVENT_TYPE, FORMATS, type FileFormat } from '../tools/attachFile.ts';
import { ALL_TIME } from '../tools/getEvents.ts';
import { type LoadedPackage, type Problem, PackageError, openInside, safeDetail } from './pkg.ts';
import { collectRefs, dependencyLevels, resolveRefs } from './refs.ts';

/** One package event, checked and normalised (refs still unresolved). */
export interface PkgEvent {
  line: number;
  sourceKey: string;
  itemKey: string | null;
  streamIds: string[];
  type: string;
  content: unknown;
  time: number;
  /** null for none: a package `0` is none too, as the core stores it */
  duration: number | null;
  description: string | null;
  /** the line's own clientData (no sourceKey, no related: the kit sets those) */
  clientData: Record<string, unknown>;
  /** package keys this event cites: in content (`$ref`) and in `relatedKeys` */
  refs: string[];
  attachment: { rel: string; size: number; mime: string } | null;
  evidence: { file: string; page: number | null; image: boolean } | null;
  root: string | null;
}

export interface Normalized {
  events: PkgEvent[];
  levels: string[][];
  problems: Problem[];
}

export interface Report {
  format: 'hds-import-report/1';
  packVersion: string | null;
  importName: string | null;
  tool: string | null;
  events: number;
  documents: number;
  /** root streams the import writes: the `roots` to pass to connect */
  roots: string[];
  byRoot: Record<string, number>;
  byItem: Record<string, number>;
  problems: Problem[];
  blocking: number;
  ok: boolean;
}

const LINE_KEYS = new Set(['sourceKey', 'itemKey', 'streamIds', 'type', 'content', 'time', 'duration', 'description', 'clientData', 'relatedKeys', 'attachment', 'evidence']);
const KIT_CLIENT_DATA_KEYS = ['sourceKey', 'related', DOCUMENT_UNIQUE_ID_KEY, 'hdsGln', 'hdsZsr'];
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SOURCE_KEY_MAX = 512;
const own = (o: unknown, k: string): boolean => o != null && typeof o === 'object' && Object.hasOwn(o, k);

/** Root stream id of each model stream id. */
export function rootsOf (pack: DataModelPack): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (list: any[], root: string | null) => {
    for (const s of list ?? []) {
      const r = root ?? s.id;
      out.set(s.id, r);
      walk(s.children ?? [], r);
    }
  };
  walk(pack.streams ?? [], null);
  return out;
}

/** A key the kit must not carry through (prototype keys): JSON.parse keeps them as own keys, copies drop them. */
function hasForbiddenKey (v: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (Array.isArray(v)) return v.some((x) => hasForbiddenKey(x, depth + 1));
  if (v != null && typeof v === 'object') {
    return Object.keys(v).some((k) => FORBIDDEN_KEYS.has(k) || hasForbiddenKey((v as any)[k], depth + 1));
  }
  return false;
}

/** Reads a file's first bytes and size: its format (PDF / JPEG / PNG, extension agreeing), or a problem code. */
async function fileCheck (root: string, rel: unknown, maxBytes: number): Promise<{ format: FileFormat; size: number } | string> {
  let opened;
  try { opened = await openInside(root, rel); } catch (err) { return err instanceof PackageError ? err.code : 'file-invalid'; }
  const { fh, size, full } = opened;
  try {
    if (size > maxBytes) return 'too-large';
    const head = Buffer.alloc(16);
    const { bytesRead } = await fh.read(head, 0, 16, 0);
    const format = FORMATS.find((f) => bytesRead >= f.magic.length && f.magic.every((b, i) => head[i] === b));
    if (!format) return 'format';
    if (!format.ext.includes(path.extname(full).toLowerCase())) return 'extension';
    return { format, size };
  } finally {
    await fh.close().catch(() => {});
  }
}

/** Checks every line against the manifest and the pack; values never appear in a problem. */
export async function normalizePackage (pkg: LoadedPackage, pack: DataModelPack): Promise<Normalized> {
  const problems: Problem[] = [...pkg.problems];
  const tool = pkg.manifest?.tool ?? null;
  const roots = rootsOf(pack);
  const types = pack.eventTypes?.types ?? {};
  const events: PkgEvent[] = [];
  const seen = new Map<string, number>();
  const bad = (code: string, line: number, detail?: unknown, blocking = true) => problems.push({ code, line, detail: safeDetail(detail), blocking });

  for (const { line, value: v } of pkg.lines) {
    if (v == null || typeof v !== 'object' || Array.isArray(v)) { bad('line-not-object', line); continue; }
    for (const k of Object.keys(v)) if (!LINE_KEYS.has(k)) bad('line-unknown-field', line, k);
    if (hasForbiddenKey(v)) { bad('key-forbidden', line, '__proto__ / constructor / prototype'); continue; }

    // sourceKey: <tool>:<kind>:<id>, one per event
    const sourceKey = v.sourceKey;
    if (typeof sourceKey !== 'string' || sourceKey.length > SOURCE_KEY_MAX || !/^[^:]+:[^:]+:.+$/.test(sourceKey) || /[\n\r]/.test(sourceKey)) {
      bad('sourcekey-invalid', line, '<tool>:<kind>:<id>');
      continue;
    }
    if (tool != null && !sourceKey.startsWith(tool + ':')) bad('sourcekey-tool', line, tool + ':');
    if (seen.has(sourceKey)) bad('sourcekey-duplicate', line, `line-${seen.get(sourceKey)}`);
    seen.set(sourceKey, line);

    // stream and type: from the item, or given
    let itemKey: string | null = null;
    let streamIds: string[] = [];
    let type: string | null = typeof v.type === 'string' ? v.type : null;
    if (v.itemKey != null) {
      const item = typeof v.itemKey === 'string' && own(pack.items, v.itemKey) ? pack.items[v.itemKey] : undefined;
      if (!item) { bad('item-unknown', line, v.itemKey); continue; }
      itemKey = v.itemKey;
      streamIds = [item.streamId];
      const itemTypes = itemEventTypes(item);
      if (type == null) {
        if (itemTypes.length === 1) type = itemTypes[0];
        else { bad('item-type-ambiguous', line, itemKey); continue; }
      } else if (!itemTypes.includes(type)) {
        bad('item-type-mismatch', line, itemKey);
        continue;
      }
      if (v.streamIds != null) bad('item-and-streamids', line);
    } else {
      if (!Array.isArray(v.streamIds) || v.streamIds.length === 0 || v.streamIds.length > 10 || !v.streamIds.every((s: unknown) => typeof s === 'string')) {
        bad('stream-missing', line);
        continue;
      }
      streamIds = v.streamIds;
      if (type == null) { bad('type-missing', line); continue; }
    }
    if (!own(types, type)) { bad('type-unknown', line, type); continue; }
    const schema = types[type];

    // content, with each $ref standing for an event id while it is checked
    const contentRefs = collectRefs(v.content);
    const errs = contentErrors(pack, type, resolveRefs(v.content, () => 'ref-placeholder-id'));
    // the type and the schema keyword only: the field path may hold the record's own keys
    for (const e of errs ?? []) bad('content-invalid', line, `${type}:${e.keyword}`);
    // an item with options takes one of them (the item key only: the value is the record's)
    const notOption = errs?.length === 0 ? optionProblem(pack, streamIds, type, v.content) : null;
    if (notOption != null) bad('content-not-an-option', line, notOption.key);

    // time inside what a re-run reads (1900-2100); never left to the core's "now"
    const time = v.time;
    if (typeof time !== 'number' || !Number.isFinite(time)) bad('time-missing', line);
    else if (time < ALL_TIME.fromTime || time >= ALL_TIME.toTime) bad('time-out-of-range', line, '1900-2100');
    let duration: number | null = null;
    if (v.duration != null) {
      if (typeof v.duration !== 'number' || !Number.isFinite(v.duration) || v.duration < 0 || v.duration > 200 * 365 * 86400) bad('duration-invalid', line);
      else if (v.duration > 0) duration = v.duration;
    }
    if (v.description != null && (typeof v.description !== 'string' || v.description.length > 10000)) bad('description-invalid', line);

    const clientData = v.clientData ?? {};
    if (typeof clientData !== 'object' || Array.isArray(clientData)) {
      bad('clientdata-invalid', line);
    } else {
      for (const k of KIT_CLIENT_DATA_KEYS) if (own(clientData, k)) bad('clientdata-reserved-key', line, k);
    }
    const relatedKeys = v.relatedKeys ?? [];
    if (!Array.isArray(relatedKeys) || !relatedKeys.every((k: unknown) => typeof k === 'string')) bad('relatedkeys-invalid', line);

    // documents: the file (under files/), and the identifier in the one spelling stored
    const attachmentRequired = schema.attachmentRequired === true;
    let attachment: PkgEvent['attachment'] = null;
    if (v.attachment != null) {
      if (!attachmentRequired) bad('attachment-not-document', line, type);
      else if (typeof v.attachment !== 'string' || !/^files[\\/]/.test(v.attachment)) bad('attachment-not-in-files', line, 'files/');
      else {
        const r = await fileCheck(pkg.root, v.attachment, ATTACH_MAX_BYTES);
        if (typeof r === 'string') bad('attachment-' + r, line, r === 'too-large' ? `${ATTACH_MAX_BYTES / (1024 * 1024)}MB` : undefined);
        else attachment = { rel: v.attachment, size: r.size, mime: r.format.mime };
      }
    } else if (attachmentRequired) {
      bad('attachment-missing', line, type);
    }
    // an importer writes a document on the root only: filing is hers (DOCUMENTS.md § Filing)
    if (type === DOCUMENT_EVENT_TYPE && documentStreamsProblem(pack, streamIds) != null) bad('document-not-on-root', line, DOCUMENTS_ROOT);
    if (type === DOCUMENT_EVENT_TYPE && (v.content as any)?.uniqueId != null) {
      const id = normalizeDocumentUniqueId((v.content as any).uniqueId);
      if (id == null) bad('document-uniqueid-not-stored', line);
      else if (JSON.stringify(id) !== JSON.stringify((v.content as any).uniqueId)) bad('document-uniqueid-not-normalized', line);
    }

    // evidence: a source page for the review only; PDF / JPEG / PNG, never another type opened from file://
    let evidence: PkgEvent['evidence'] = null;
    if (v.evidence != null) {
      const r = await fileCheck(pkg.root, v.evidence?.file, 100 * 1024 * 1024);
      if (typeof r === 'string') bad('evidence-' + r, line, undefined, false);
      else evidence = { file: v.evidence.file, page: Number.isInteger(v.evidence.page) && v.evidence.page > 0 ? v.evidence.page : null, image: r.format.mime !== 'application/pdf' };
    }

    events.push({
      line,
      sourceKey,
      itemKey,
      streamIds,
      type,
      content: v.content === undefined ? null : v.content,
      time: typeof time === 'number' && Number.isFinite(time) ? time : 0,
      duration,
      description: typeof v.description === 'string' && v.description !== '' ? v.description : null,
      clientData: (clientData && typeof clientData === 'object' && !Array.isArray(clientData)) ? clientData : {},
      refs: [...new Set([...contentRefs, ...(Array.isArray(relatedKeys) ? relatedKeys : [])])],
      attachment,
      evidence,
      root: roots.get(streamIds[0]) ?? null
    });
  }

  for (const e of events) {
    for (const s of e.streamIds) if (!roots.has(s)) problems.push({ code: 'stream-not-in-model', line: e.line, detail: safeDetail(s), blocking: true });
    if (new Set(e.streamIds.map((s) => roots.get(s))).size > 1) problems.push({ code: 'streams-several-roots', line: e.line, blocking: true });
    for (const r of e.refs) if (!seen.has(r)) problems.push({ code: 'ref-dangling', line: e.line, blocking: true });
  }
  const docIds = new Map<string, number>();
  for (const e of events) {
    if (e.type !== DOCUMENT_EVENT_TYPE) continue;
    const id = normalizeDocumentUniqueId((e.content as any)?.uniqueId);
    if (id == null) continue;
    const k = id.system + '|' + id.value;
    if (docIds.has(k)) problems.push({ code: 'document-uniqueid-duplicate', line: e.line, detail: `line-${docIds.get(k)}`, blocking: true });
    else docIds.set(k, e.line);
  }
  const { levels, cycle } = dependencyLevels(new Map(events.map((e) => [e.sourceKey, e.refs])));
  for (const k of cycle) problems.push({ code: 'ref-cycle', line: seen.get(k), blocking: true });
  return { events, levels, problems };
}

/** The report of a check: counts and codes only. */
export function buildReport (pkg: LoadedPackage, pack: DataModelPack, n: Normalized): Report {
  const byRoot: Record<string, number> = {};
  const byItem: Record<string, number> = {};
  for (const e of n.events) {
    if (e.root) byRoot[e.root] = (byRoot[e.root] ?? 0) + 1;
    const k = e.itemKey ?? e.type;
    byItem[k] = (byItem[k] ?? 0) + 1;
  }
  const blocking = n.problems.filter((p) => p.blocking).length;
  return {
    format: 'hds-import-report/1',
    packVersion: pack.version ?? null,
    importName: pkg.manifest?.importName ?? null,
    tool: pkg.manifest?.tool ?? null,
    events: n.events.length,
    documents: n.events.filter((e) => e.type === DOCUMENT_EVENT_TYPE).length,
    roots: Object.keys(byRoot).sort(),
    byRoot,
    byItem,
    problems: n.problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0)),
    blocking,
    ok: blocking === 0 && pkg.valid
  };
}
