import type { DataModelPack } from './pack.ts';
import { modelPath } from '../tools/ensureStreams.ts';

// Where a file/xds-v1 document is written (data-model 4.35.0, DOCUMENTS.md § Filing): the `documents` root holds what
// is not filed yet; its children are access classes (`documents-clinical`, `documents-admin` > `documents-admin-insurance`).
// Filing is hers: her app files a document when she says so. Every other writer, an assistant and an importer
// included, writes on the root only, since a document on a class stream is read by that class's readers without her
// having said so. A kind names the class her app proposes (`stream` on the kind); this module only says it.

export const DOCUMENTS_ROOT = 'documents';
const SNOMED = 'http://snomed.info/sct';

interface Coding { system?: string; code?: string }
interface KindDef { class: Coding; type: Coding; detail?: Coding; stream?: string }

const same = (a: Coding | undefined, b: Coding | undefined): boolean =>
  a?.code != null && b?.system != null && a.code === b.code && (a.system ?? SNOMED) === b.system;

/**
 * The kind key of a document's content (its Codings must carry their system): a detail kind when a type Coding names
 * its detail, else the kind with this class and first type Coding. Null when none matches. It only words a note.
 */
export function kindOfContent (pack: DataModelPack, content: unknown): string | null {
  const c = content as { class?: Coding; type?: Coding[] } | null;
  if (c == null || typeof c !== 'object' || !Array.isArray(c.type)) return null;
  const kinds = (pack.documentKinds?.kinds ?? {}) as Record<string, KindDef>;
  const detailKinds = (pack.documentKinds?.detailKinds ?? {}) as Record<string, KindDef>;
  for (const [key, k] of Object.entries(detailKinds)) {
    if (same(k.class, c.class) && same(k.type, c.type[0]) && c.type.some((t) => same(k.detail, t))) return key;
  }
  for (const [key, k] of Object.entries(kinds)) {
    if (same(k.class, c.class) && same(k.type, c.type[0])) return key;
  }
  return null;
}

/** A model stream's English label (its id when the model lacks it). */
export function streamLabel (pack: DataModelPack, id: string): string {
  const s = modelPath((pack.streams ?? []) as any[], id)?.at(-1);
  return s?.label?.en ?? s?.name ?? id;
}

/**
 * True for `documents` and every stream below it; an id the model does not know counts by its `documents-` prefix
 * (an older pack, as hds-lib `ancestorsOf`).
 */
export function isDocumentsStream (pack: DataModelPack, id: string): boolean {
  const p = modelPath((pack.streams ?? []) as any[], id);
  return p != null ? p[0].id === DOCUMENTS_ROOT : (id === DOCUMENTS_ROOT || id.startsWith(DOCUMENTS_ROOT + '-'));
}

/** The class her app proposes for a kind: its `stream` when the model knows it under `documents`, else the root. */
export function streamForKind (pack: DataModelPack, key: string | null): string {
  if (key == null) return DOCUMENTS_ROOT;
  const k = (pack.documentKinds?.kinds?.[key] ?? pack.documentKinds?.detailKinds?.[key]) as KindDef | undefined;
  return k?.stream != null && modelPath((pack.streams ?? []) as any[], k.stream)?.[0].id === DOCUMENTS_ROOT ? k.stream : DOCUMENTS_ROOT;
}

/**
 * What is wrong with a new document's streamIds for this writer, or null. Exactly `["documents"]`: a class stream files
 * it and a `share-…` id (or any other stream) shares it, and both are the person's, in their HDS app.
 */
export function documentStreamsProblem (pack: DataModelPack, streamIds: string[]): string | null {
  if (streamIds.length === 1 && streamIds[0] === DOCUMENTS_ROOT) return null;
  const filed = streamIds.filter((s) => s !== DOCUMENTS_ROOT && isDocumentsStream(pack, s));
  return `a new document is written on stream "${DOCUMENTS_ROOT}" alone` +
    (filed.length > 0 ? `, not on "${filed.join('", "')}"` : '') +
    ': filing and sharing it are the person\'s, in their HDS app';
}

/** The sentence a writer returns about a document on the root: the class the person can file it in, if any. */
export function filingNote (pack: DataModelPack, content: unknown): string {
  const kind = kindOfContent(pack, content);
  const target = streamForKind(pack, kind);
  if (target !== DOCUMENTS_ROOT) {
    return `Not filed: it is on "${DOCUMENTS_ROOT}". The person can file it under "${streamLabel(pack, target)}" in their ` +
      'HDS app; filing decides who it is shared with, so it is theirs to do.';
  }
  return kind != null ? `Not filed: it is on "${DOCUMENTS_ROOT}", where its kind stays.` : `Not filed: it is on "${DOCUMENTS_ROOT}".`;
}
