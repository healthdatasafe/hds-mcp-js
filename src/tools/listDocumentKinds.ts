import { z } from 'zod';
import { loadPack, en } from '../dataModel/pack.ts';
import { packLabel } from '../dataModel/eventTypes.ts';

// The document kinds of the data model (4.17.0, pack.documentKinds, DOCUMENTS.md § Document kinds): which class and
// type Codings a file/xds-v1 document writes, and which printed date is its event time.

interface Coding { system: string; version?: string; code: string; display: string }
interface DocumentKind {
  label: Record<string, string>;
  description: Record<string, string>;
  class: Coding;
  type: Coding;
  timeBasis: 'service' | 'creation';
  deprecated?: true;
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
  const kinds = (pack.documentKinds?.kinds ?? {}) as Record<string, DocumentKind>;
  if (Object.keys(kinds).length === 0) {
    return { content: [{ type: 'text', text: `The loaded data model (${packLabel(pack)}) has no document kinds: they came with data-model 4.17.0.` }] };
  }
  if (args.key != null) {
    const kind = kinds[args.key];
    if (!kind) throw new Error(`Unknown document kind "${args.key}". Call list_document_kinds without a key for the list.`);
    return {
      content: [{
        type: 'text',
        text: `Document kind ${args.key}: ${en(kind.label)}. Copy class into content.class and type as content.type[0], ` +
          `unchanged. Event time: ${TIME_BASIS[kind.timeBasis]} (timeBasis ${kind.timeBasis}).` +
          (kind.deprecated ? ' Deprecated: a stored document still reads back, never pick it for a new one.' : '')
      }, {
        type: 'text',
        text: '```json\n' + JSON.stringify({ class: kind.class, type: kind.type }, null, 2) + '\n```'
      }]
    };
  }
  const lines = Object.entries(kinds).filter(([, k]) => !k.deprecated).map(([key, k]) => {
    const other = ['fr', 'de', 'it'].filter((l) => k.label[l]).map((l) => `${l} ${k.label[l]}`).join(', ');
    return `- **${key}** — ${en(k.label)}${other ? ` (${other})` : ''}: ${en(k.description)}\n` +
      `  class ${code(k.class)} · type ${code(k.type)} · timeBasis ${k.timeBasis}`;
  });
  return {
    content: [{
      type: 'text',
      text: `Document kinds of the HDS data model (${packLabel(pack)}), from the Swiss EPR value sets (CH Term ` +
        `${pack.documentKinds.source?.version ?? ''}). Pick one by its description; when none fits use the ` +
        'class\'s other-… kind, or "other". Then list_document_kinds({ key }) gives the exact Codings to copy (a Swiss ' +
        'extension code carries its edition as version). timeBasis: service = ' + TIME_BASIS.service + '; creation = ' +
        TIME_BASIS.creation + '. Only a date from the document\'s body counts, never a fax, scan, print or upload ' +
        'date; a date with no hour is 12:00 UTC with clientData.hdsTimePrecision "day". Rules: data-model ' +
        'DOCUMENTS.md, "Document kinds" and "Which date is a document\'s date".\n\n' + lines.join('\n')
    }]
  };
}
