import { promises as fsp, constants } from 'node:fs';
import path from 'node:path';
import type { DataModelPack } from '../dataModel/pack.ts';
import { contentErrors, contentSchema, itemEventTypes } from '../dataModel/eventTypes.ts';
import { normalizeDocumentUniqueId, documentUniqueIdKey, DOCUMENT_UNIQUE_ID_KEY } from '../dataModel/documentUniqueId.ts';
import { ATTACH_MAX_BYTES, DOCUMENT_EVENT_TYPE, FORMATS } from '../tools/attachFile.ts';
import { ALL_TIME } from '../tools/getEvents.ts';
import { type LoadedPackage, type Problem, PackageError, resolveInside } from './pkg.ts';
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
  duration: number | null;
  description: string | null;
  /** the line's own clientData (no sourceKey, no related: the kit sets those) */
  clientData: Record<string, unknown>;
  /** package keys this event cites: in content (`$ref`) and in `relatedKeys` */
  refs: string[];
  attachment: string | null;
  evidence: { file: string; page: number | null } | null;
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

/** Checks every line against the manifest and the pack; values never appear in a problem. */
export async function normalizePackage (pkg: LoadedPackage, pack: DataModelPack): Promise<Normalized> {
  const problems: Problem[] = [...pkg.problems];
  const tool = typeof pkg.manifest?.tool === 'string' ? pkg.manifest.tool : null;
  const roots = rootsOf(pack);
  const events: PkgEvent[] = [];
  const seen = new Map<string, number>();
  const bad = (code: string, line: number, detail?: string, blocking = true) => problems.push({ code, line, detail, blocking });

  for (const { line, value: v } of pkg.lines) {
    if (v == null || typeof v !== 'object' || Array.isArray(v)) { bad('line-not-object', line); continue; }
    for (const k of Object.keys(v)) if (!LINE_KEYS.has(k)) bad('line-unknown-field', line, k);

    // sourceKey: <tool>:<kind>:<id>, one per event
    const sourceKey = v.sourceKey;
    if (typeof sourceKey !== 'string' || !/^[^:]+:[^:]+:.+$/.test(sourceKey) || /[\n\r]/.test(sourceKey)) {
      bad('sourcekey-invalid', line, '<tool>:<kind>:<id>');
      continue;
    }
    if (tool != null && !sourceKey.startsWith(tool + ':')) bad('sourcekey-tool', line, `must start with "${tool}:"`);
    if (seen.has(sourceKey)) bad('sourcekey-duplicate', line, `also on line ${seen.get(sourceKey)}`);
    seen.set(sourceKey, line);

    // stream and type: from the item, or given
    let itemKey: string | null = null;
    let streamIds: string[] = [];
    let type: string | null = typeof v.type === 'string' ? v.type : null;
    if (v.itemKey != null) {
      const item = typeof v.itemKey === 'string' ? pack.items[v.itemKey] : undefined;
      if (!item) { bad('item-unknown', line, String(v.itemKey).slice(0, 80)); continue; }
      itemKey = v.itemKey;
      streamIds = [item.streamId];
      const types = itemEventTypes(item);
      if (type == null) {
        if (types.length === 1) type = types[0];
        else { bad('item-type-ambiguous', line, `${itemKey}: give type, one of ${types.join(', ')}`); continue; }
      } else if (!types.includes(type)) {
        bad('item-type-mismatch', line, `${itemKey} takes ${types.join(', ')}`);
        continue;
      }
      if (v.streamIds != null) bad('item-and-streamids', line, 'give itemKey or streamIds, not both');
    } else {
      if (!Array.isArray(v.streamIds) || v.streamIds.length === 0 || !v.streamIds.every((s: unknown) => typeof s === 'string')) {
        bad('stream-missing', line, 'give itemKey, or streamIds and type');
        continue;
      }
      streamIds = v.streamIds;
      if (type == null) { bad('type-missing', line); continue; }
    }
    const schema = contentSchema(pack, type);
    if (!schema) { bad('type-unknown', line, type); continue; }

    // content, with each $ref standing for an event id while it is checked
    const contentRefs = collectRefs(v.content);
    const errs = contentErrors(pack, type, resolveRefs(v.content, () => 'ref-placeholder-id'));
    for (const e of errs ?? []) bad('content-invalid', line, `${type} ${e.path} ${e.keyword}`);

    // time inside what a re-run reads (1900-2100); never left to the core's "now"
    const time = v.time;
    if (typeof time !== 'number' || !Number.isFinite(time)) bad('time-missing', line);
    else if (time < ALL_TIME.fromTime || time >= ALL_TIME.toTime) bad('time-out-of-range', line, '1900-2100');
    if (v.duration != null && (typeof v.duration !== 'number' || v.duration < 0)) bad('duration-invalid', line);
    if (v.description != null && typeof v.description !== 'string') bad('description-invalid', line);

    const clientData = v.clientData ?? {};
    if (typeof clientData !== 'object' || Array.isArray(clientData)) {
      bad('clientdata-invalid', line);
    } else {
      for (const k of KIT_CLIENT_DATA_KEYS) if (k in clientData) bad('clientdata-reserved-key', line, `${k} is set by the kit`);
    }
    const relatedKeys = v.relatedKeys ?? [];
    if (!Array.isArray(relatedKeys) || !relatedKeys.every((k: unknown) => typeof k === 'string')) bad('relatedkeys-invalid', line);

    // documents: the file, and the identifier in the one spelling stored
    const attachmentRequired = schema.attachmentRequired === true;
    let attachment: string | null = null;
    if (v.attachment != null) {
      if (!attachmentRequired) bad('attachment-not-document', line, type);
      else attachment = await checkAttachment(pkg.root, v.attachment, line, bad);
    } else if (attachmentRequired) {
      bad('attachment-missing', line, type);
    }
    if (type === DOCUMENT_EVENT_TYPE && (v.content as any)?.uniqueId != null) {
      const id = normalizeDocumentUniqueId((v.content as any).uniqueId);
      if (id == null) bad('document-uniqueid-not-stored', line, 'DOCUMENTS.md "One spelling"');
      else if (JSON.stringify(id) !== JSON.stringify((v.content as any).uniqueId) && typeof (v.content as any).uniqueId === 'object') {
        bad('document-uniqueid-not-normalized', line, documentUniqueIdKey(id).split('|')[0]);
      }
    }

    let evidence: PkgEvent['evidence'] = null;
    if (v.evidence != null) {
      try {
        await resolveInside(pkg.root, v.evidence?.file);
        evidence = { file: v.evidence.file, page: Number.isInteger(v.evidence.page) ? v.evidence.page : null };
      } catch (err) {
        bad(err instanceof PackageError ? 'evidence-' + err.code : 'evidence-invalid', line, undefined, false);
      }
    }

    events.push({
      line,
      sourceKey,
      itemKey,
      streamIds,
      type,
      content: v.content === undefined ? null : v.content,
      time: typeof time === 'number' ? time : 0,
      duration: typeof v.duration === 'number' ? v.duration : null,
      description: typeof v.description === 'string' ? v.description : null,
      clientData: (clientData && typeof clientData === 'object' && !Array.isArray(clientData)) ? clientData : {},
      refs: [...new Set([...contentRefs, ...(Array.isArray(relatedKeys) ? relatedKeys : [])])],
      attachment,
      evidence,
      root: roots.get(streamIds[0]) ?? null
    });
  }

  for (const e of events) {
    if (e.root == null) problems.push({ code: 'stream-not-in-model', line: e.line, detail: e.streamIds[0], blocking: true });
    for (const r of e.refs) if (!seen.has(r)) problems.push({ code: 'ref-dangling', line: e.line, blocking: true });
  }
  const { levels, cycle } = dependencyLevels(new Map(events.map((e) => [e.sourceKey, e.refs])));
  for (const k of cycle) problems.push({ code: 'ref-cycle', line: seen.get(k), blocking: true });
  return { events, levels, problems };
}

async function checkAttachment (root: string, rel: unknown, line: number, bad: (c: string, l: number, d?: string) => void): Promise<string | null> {
  let full: string;
  try { full = await resolveInside(root, rel); } catch (err) {
    bad(err instanceof PackageError ? 'attachment-' + err.code : 'attachment-invalid', line);
    return null;
  }
  const fh = await fsp.open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = await fh.stat();
    if (st.size > ATTACH_MAX_BYTES) { bad('attachment-too-large', line, `over ${ATTACH_MAX_BYTES / (1024 * 1024)} MB`); return null; }
    const head = Buffer.alloc(16);
    const { bytesRead } = await fh.read(head, 0, 16, 0);
    const format = FORMATS.find((f) => bytesRead >= f.magic.length && f.magic.every((b, i) => head[i] === b));
    if (!format) { bad('attachment-format', line, 'PDF, JPEG or PNG'); return null; }
    if (!format.ext.includes(path.extname(full).toLowerCase())) { bad('attachment-extension', line, format.ext.join(' or ')); return null; }
  } finally {
    await fh.close().catch(() => {});
  }
  return rel as string;
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
    importName: (pkg.manifest?.importName as string) ?? null,
    tool: (pkg.manifest?.tool as string) ?? null,
    events: n.events.length,
    documents: n.events.filter((e) => e.type === DOCUMENT_EVENT_TYPE).length,
    roots: Object.keys(byRoot).sort(),
    byRoot,
    byItem,
    problems: n.problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0)),
    blocking,
    ok: blocking === 0
  };
}
