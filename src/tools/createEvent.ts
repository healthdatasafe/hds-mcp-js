import { z } from 'zod';
import { apiPost } from '../lib/apiCall.ts';
import { loadPack } from '../dataModel/pack.ts';
import { validateEvent } from '../dataModel/eventTypes.ts';

export const createEventInput = {
  streamIds: z.array(z.string()).min(1).describe(
    'Stream IDs the event belongs to. For HDS items, use the canonical streamId from get_item; ' +
    'for user-created streams, use list_streams to discover. At least one required.'
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
  }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const problems = validateEvent(await loadPack(), args.type, args.content);
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
  return {
    content: [{
      type: 'text',
      text: `Created event ${(event as any).id ?? '(no id)'} of type ${args.type} in stream(s) ${args.streamIds.join(', ')}.`
    }, {
      type: 'text',
      text: '```json\n' + JSON.stringify(event, null, 2) + '\n```'
    }]
  };
}
