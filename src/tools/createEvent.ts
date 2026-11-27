import { z } from 'zod';
import { apiPost } from '../lib/apiCall.ts';
import { loadPack } from '../dataModel/pack.ts';
import { contentSchema, validateEvent } from '../dataModel/eventTypes.ts';
import { documentStreamsProblem, filingNote } from '../dataModel/documentStreams.ts';
import { DOCUMENT_EVENT_TYPE } from './attachFile.ts';

export const createEventInput = {
  streamIds: z.array(z.string()).min(1).describe(
    'Stream IDs the event belongs to. For HDS items, use the canonical streamId from get_item; ' +
    'for user-created streams, use list_streams to discover. At least one required. A document (file/xds-v1) goes ' +
    'on ["documents"] alone, never on a stream below it or a share: filing and sharing it are the person\'s, in their ' +
    'HDS app.'
  ),
  type: z.string().describe(
    'Event type. Use the eventType returned by get_item for the canonical HDS item ' +
    '(call search_items → get_item first). Examples: "mass/kg", "note/txt", "temperature/c", "checkbox/null". ' +
    'Do not invent types — if no HDS item matches, ask the user.'
  ),
  content: z.unknown().optional().describe(
    'Event content. Must match the content schema get_item returns for this eventType; ' +
    'it is checked before writing and the event is refused if it does not match.'
  ),
  time: z.number().optional().describe(
    'Unix timestamp (seconds, float). Defaults to "now" on the server.'
  ),
  duration: z.number().nonnegative().optional().describe(
    'Duration in seconds. Omit for instantaneous events.'
  ),
  tags: z.array(z.string()).optional().describe('Optional free-text tags.'),
  description: z.string().optional().describe(
    'Optional short human-readable text shown with the event in every HDS app ' +
    '(e.g. "pelvic pain, on bowel movement", "date reported from memory").'
  ),
  clientData: z.record(z.string(), z.unknown()).optional().describe(
    'Optional structured metadata defined by the HDS data-model conventions ' +
    '(e.g. sourceKey and related for provenance, hdsTimePrecision for partial dates, ' +
    'hdsRefRange / hdsFlag / hdsComparator for lab values as printed). ' +
    'Follow the data-model documentation for the keys; do not invent HDS keys.'
  )
};

export async function createEventHandler (
  args: {
    streamIds: string[];
    type: string;
    content?: unknown;
    time?: number;
    duration?: number;
    tags?: string[];
    description?: string;
    clientData?: Record<string, unknown>;
  },
  { attachFile = false }: { attachFile?: boolean } = {}
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const pack = await loadPack();
  const problems = validateEvent(pack, args.type, args.content, { attachFile, streamIds: args.streamIds });
  const isDocument = args.type === DOCUMENT_EVENT_TYPE;
  const streamsProblem = isDocument ? documentStreamsProblem(pack, args.streamIds) : null;
  if (streamsProblem != null) problems.push(streamsProblem);
  if (problems.length > 0) {
    throw new Error(`Event refused, nothing written: ${problems.join('; ')}`);
  }
  const body: Record<string, unknown> = {
    streamIds: args.streamIds,
    type: args.type
  };
  if (args.content !== undefined) body.content = args.content;
  if (args.time !== undefined) body.time = args.time;
  if (args.duration !== undefined) body.duration = args.duration;
  if (args.tags !== undefined) body.tags = args.tags;
  if (args.description !== undefined) body.description = args.description;
  if (args.clientData !== undefined) body.clientData = args.clientData;

  const res = await apiPost('/events', body);
  const event = (res as any).event ?? res;
  const needsFile = contentSchema(pack, args.type)?.attachmentRequired === true;
  const filing = isDocument ? filingNote(pack, args.content) : null;
  return {
    content: [{
      type: 'text',
      text: `Created event ${(event as any).id ?? '(no id)'} of type ${args.type} in stream(s) ${args.streamIds.join(', ')}.` +
        (filing != null ? ' ' + filing : '') +
        (needsFile ? ' It has no file yet: add it with attach_file.' : '')
    }, {
      type: 'text',
      text: '```json\n' + JSON.stringify(event, null, 2) + '\n```'
    }]
  };
}
