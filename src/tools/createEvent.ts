import { z } from 'zod';
import { apiPost } from '../lib/apiCall.ts';

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
    'Event content. Shape depends on type — typically a number, string, or object with the value.'
  ),
  time: z.number().optional().describe(
    'Unix timestamp (seconds, float). Defaults to "now" on the server.'
  ),
  duration: z.number().nonnegative().optional().describe(
    'Duration in seconds. Omit for instantaneous events.'
  ),
  tags: z.array(z.string()).optional().describe('Optional free-text tags.')
};

export async function createEventHandler (
  args: {
    streamIds: string[];
    type: string;
    content?: unknown;
    time?: number;
    duration?: number;
    tags?: string[];
  }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const body: Record<string, unknown> = {
    streamIds: args.streamIds,
    type: args.type
  };
  if (args.content !== undefined) body.content = args.content;
  if (args.time !== undefined) body.time = args.time;
  if (args.duration !== undefined) body.duration = args.duration;
  if (args.tags !== undefined) body.tags = args.tags;

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
