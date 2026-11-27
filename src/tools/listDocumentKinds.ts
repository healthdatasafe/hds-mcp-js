import { z } from 'zod';
import { loadPack, en } from '../dataModel/pack.ts';
import { packLabel } from '../dataModel/eventTypes.ts';
import { DOCUMENTS_ROOT, streamForKind, streamLabel } from '../dataModel/documentStreams.ts';

// The document kinds of the data model (4.17.0, pack.documentKinds, DOCUMENTS.md § Document kinds): which class and
// type Codings a file/xds-v1 document writes, and which printed date is its event time. The kinds no CH Term pair names
// (4.32.0, documentKinds.detailKinds) share the class and type of one of them and add `detail`, the second Coding of
// `type`, listed after the kind they share their codes with (as hds-lib's documentKinds).

interface Coding { system: string; version?: string; code: string; display: string }
interface DocumentKind {
  label: Record<string, string>;
  description: Record<string, string>;
  class: Coding;
  type: Coding;
  detail?: Coding;
  timeBasis: 'service' | 'creation';
  deprecated?: true;
}

/** Every kind, a detail kind after the one it shares its class and type with */
function allKinds (documentKinds: any): Record<string, DocumentKind> {
  const kinds = (documentKinds?.kinds ?? {}) as Record<string, DocumentKind>;
  const detailKinds = (documentKinds?.detailKinds ?? {}) as Record<string, DocumentKind>;
  const all: Record<string, DocumentKind> = {};
  for (const [key, k] of Object.entries(kinds)) {
    all[key] = k;
    for (const [detailKey, d] of Object.entries(detailKinds)) {
      if (d.class.code === k.class.code && d.type.code === k.type.code) all[detailKey] = d;
    }
  }
  return all;
}

export const listDocumentKindsInput = {
  key: z.string().optional().describe(
    'A kind key (e.g. "laboratory-report"): returns its class and type Codings as JSON, to copy into the content. ' +
    'Omit to list every kind.'
  )
};

const TIME_BASIS: Record<string, string> = {
  service: 'the date of the care reported (sample, examination, visit; care over a period: the day it ended)',
  creation: 'the date the document was written or signed'
};

const code = (c: Coding): string => `${c.code} ${c.display}${c.version ? ' [Swiss extension]' : ''}`;

export async function listDocumentKindsHandler (
  args: { key?: string }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const pack = await loadPack();
  const kinds = allKinds(pack.documentKinds);
  if (Object.keys(kinds).length === 0) {
    return { content: [{ type: 'text', text: `The loaded data model (${packLabel(pack)}) has no document kinds: they came with data-model 4.17.0.` }] };
  }
  if (args.key != null) {
    const kind = kinds[args.key];
    if (!kind) throw new Error(`Unknown document kind "${args.key}". Call list_document_kinds without a key for the list.`);
    const stream = streamForKind(pack, args.key);
    return {
      content: [{
        type: 'text',
        text: `Document kind ${args.key}: ${en(kind.label)}. Copy class into content.class and type as content.type[0]` +
          (kind.detail ? ', then detail as content.type[1] (without it the document reads as the kind with the same class and type)' : '') +
          `, unchanged. Event time: ${TIME_BASIS[kind.timeBasis]} (timeBasis ${kind.timeBasis}). ` +
          `Write it on stream "${DOCUMENTS_ROOT}" (not filed)` +
          (stream === DOCUMENTS_ROOT
            ? ', where this kind stays.'
            : `; the person can file it under "${streamLabel(pack, stream)}" in their HDS app.`) +
          (kind.deprecated ? ' Deprecated: a stored document still reads back, never pick it for a new one.' : '')
      }, {
        type: 'text',
        text: '```json\n' + JSON.stringify({ class: kind.class, type: kind.type, ...(kind.detail ? { detail: kind.detail } : {}) }, null, 2) + '\n```'
      }]
    };
  }
  const lines = Object.entries(kinds).filter(([, k]) => !k.deprecated).map(([key, k]) => {
    const other = ['fr', 'de', 'it'].filter((l) => k.label[l]).map((l) => `${l} ${k.label[l]}`).join(', ');
    return `- **${key}** — ${en(k.label)}${other ? ` (${other})` : ''}: ${en(k.description)}\n` +
      `  class ${code(k.class)} · type ${code(k.type)}${k.detail ? ` + detail ${k.detail.code}` : ''} · timeBasis ${k.timeBasis}`;
  });
  return {
    content: [{
      type: 'text',
      text: `Document kinds of the HDS data model (${packLabel(pack)}), from the Swiss EPR value sets (CH Term ` +
        `${pack.documentKinds.source?.version ?? ''}). Pick one by its description; when none fits use the ` +
        'class\'s other-… kind, or "other". Then list_document_kinds({ key }) gives the exact Codings to copy (a Swiss ' +
        'extension code carries its edition as version). timeBasis: service = ' + TIME_BASIS.service + '; creation = ' +
        TIME_BASIS.creation + '. Only a date from the document\'s body counts, never a fax, scan, print or upload ' +
        'date; a date with no hour is 12:00 UTC with clientData.hdsTimePrecision "day". Every document goes on stream ' +
        `"${DOCUMENTS_ROOT}": filing it in a class is the person's, in their HDS app. Rules: data-model DOCUMENTS.md, "Document ` +
        'kinds", "Filing" and "Which date is a document\'s date".\n\n' + lines.join('\n')
    }]
  };
}
