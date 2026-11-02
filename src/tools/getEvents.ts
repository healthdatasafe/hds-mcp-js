import { z } from 'zod';
import { apiBatch } from '../lib/apiCall.ts';

// 1900 to 2100: records of the past can be pre-1970 (negative time).
export const ALL_TIME = { fromTime: -2208988800, toTime: 4102444800 };

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
  ),
  skip: z.number().int().nonnegative().optional().describe(
    'Skip this many events (paging: call again with skip = previous skip + limit while a page comes back full).'
  ),
  state: z.enum(['default', 'trashed', 'all']).optional().describe(
    "'default' (not trashed), 'trashed', or 'all'. Use 'all' to re-run an import: a trashed event was removed by the " +
    'user and must stay removed, so its sourceKey must be seen.'
  ),
  sourceKeyPrefix: z.string().optional().describe(
    'Only events whose clientData.sourceKey starts with this (e.g. "healthfiles:" for everything one import wrote). ' +
    'Without fromTime / toTime the whole time range 1900-2100 is searched.'
  ),
  relatedTo: z.string().optional().describe(
    'Only events that cite this event id in clientData.related (e.g. the values read from one document).'
  )
};

export async function getEventsHandler (
  args: {
    streams?: string[];
    types?: string[];
    fromTime?: number;
    toTime?: number;
    limit?: number;
    skip?: number;
    state?: 'default' | 'trashed' | 'all';
    sourceKeyPrefix?: string;
    relatedTo?: string;
  }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const params = eventsGetParams(args);
  const [res] = await apiBatch([{ method: 'events.get', params }]);
  if (res?.error) throw new Error(`Pryv events.get failed: ${res.error.message ?? res.error.id ?? 'unknown error'}`);
  const events = res?.events ?? [];
  const summary = `Got ${events.length} event(s)` +
    (args.streams?.length ? ` from streams ${args.streams.join(', ')}` : '') +
    (args.types?.length ? ` of types ${args.types.join(', ')}` : '') +
    (args.sourceKeyPrefix ? ` with sourceKey prefix "${args.sourceKeyPrefix}"` : '') +
    (args.relatedTo ? ` citing ${args.relatedTo}` : '') +
    (args.state && args.state !== 'default' ? ` (state: ${args.state})` : '') +
    '.' +
    (events.length === params.limit ? ` More may exist: call again with skip: ${(params.skip as number ?? 0) + events.length}.` : '');
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

export function eventsGetParams (args: {
  streams?: string[];
  types?: string[];
  fromTime?: number;
  toTime?: number;
  limit?: number;
  skip?: number;
  state?: 'default' | 'trashed' | 'all';
  sourceKeyPrefix?: string;
  relatedTo?: string;
}): Record<string, unknown> {
  const params: Record<string, unknown> = { limit: args.limit ?? 100 };
  if (args.streams?.length) params.streams = args.streams;
  if (args.types?.length) params.types = args.types;
  if (args.skip) params.skip = args.skip;
  if (args.state && args.state !== 'default') params.state = args.state;
  const clientData: Array<Record<string, unknown>> = [];
  if (args.sourceKeyPrefix) clientData.push({ path: 'sourceKey', prefix: args.sourceKeyPrefix });
  if (args.relatedTo) clientData.push({ path: `related.${args.relatedTo}`, exists: true });
  if (clientData.length > 0) params.clientData = clientData;
  const wide = clientData.length > 0;
  if (args.fromTime != null) params.fromTime = args.fromTime;
  else if (wide) params.fromTime = ALL_TIME.fromTime;
  if (args.toTime != null) params.toTime = args.toTime;
  else if (wide) params.toTime = ALL_TIME.toTime;
  return params;
}
