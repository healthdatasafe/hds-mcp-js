import { z } from 'zod';
import { apiGet } from '../lib/apiCall.ts';

export const getEventsInput = {
  streams: z.array(z.string()).optional().describe(
    'Filter by one or more stream IDs. Omit to query across all streams.'
  ),
  types: z.array(z.string()).optional().describe(
    'Filter by one or more event types (e.g. ["mass/kg", "note/txt"]).'
  ),
  fromTime: z.number().optional().describe('Unix timestamp (seconds) — lower bound.'),
  toTime: z.number().optional().describe('Unix timestamp (seconds) — upper bound.'),
  limit: z.number().int().positive().max(1000).optional().describe(
    'Max events to return. Default 100, max 1000.'
  )
};

export async function getEventsHandler (
  args: {
    streams?: string[];
    types?: string[];
    fromTime?: number;
    toTime?: number;
    limit?: number;
  }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const query: Record<string, unknown> = {
    limit: args.limit ?? 100
  };
  if (args.streams?.length) query.streams = args.streams;
  if (args.types?.length) query.types = args.types;
  if (args.fromTime != null) query.fromTime = args.fromTime;
  if (args.toTime != null) query.toTime = args.toTime;

  const body = await apiGet('/events', query);
  const events = (body as any).events ?? [];
  const summary = `Got ${events.length} event(s)` +
    (args.streams?.length ? ` from streams ${args.streams.join(', ')}` : '') +
    (args.types?.length ? ` of types ${args.types.join(', ')}` : '') +
    '.';
  return {
    content: [{
      type: 'text',
      text: summary
    }, {
      type: 'text',
      text: '```json\n' + JSON.stringify(events, null, 2) + '\n```'
    }]
  };
}
