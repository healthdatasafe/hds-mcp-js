import { z } from 'zod';
import { apiBatch } from '../lib/apiCall.ts';
import { eventsGetParams } from './getEvents.ts';

export const deleteEventsInput = {
  ids: z.array(z.string().min(1)).max(1000).optional().describe('Event ids to delete.'),
  sourceKeyPrefix: z.string().min(2).optional().describe(
    'Delete everything one import wrote: every event whose clientData.sourceKey starts with this (e.g. "healthfiles:").'
  ),
  confirm: z.boolean().optional().describe(
    'false or omitted: dry run, list what would be deleted. true: delete, only after the user agreed to the list. ' +
    'A first delete moves events to the trash; deleting trashed events removes them for good.'
  )
};

interface Ev { id: string; type: string; trashed?: boolean; clientData?: { sourceKey?: string; related?: Record<string, unknown> } }

/** Citing events first, then the sources they cite (llms-full §5f.6). */
export function citingFirst (events: Ev[]): Ev[] {
  const cited = new Set(events.flatMap((e) => Object.keys(e.clientData?.related ?? {})));
  return [...events.filter((e) => !cited.has(e.id)), ...events.filter((e) => cited.has(e.id))];
}

export async function deleteEventsHandler (
  { ids, sourceKeyPrefix, confirm }: { ids?: string[]; sourceKeyPrefix?: string; confirm?: boolean }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!ids?.length && !sourceKeyPrefix) throw new Error('Give ids or a sourceKeyPrefix.');
  let events: Ev[];
  if (sourceKeyPrefix) {
    const [res] = await apiBatch([{ method: 'events.get', params: eventsGetParams({ sourceKeyPrefix, state: 'all', limit: 1000 }) }]);
    if (res?.error) throw new Error(`Pryv events.get failed: ${res.error.message ?? res.error.id}`);
    events = (res?.events ?? []).filter((e: Ev) => !ids?.length || ids.includes(e.id));
  } else {
    const got = await apiBatch(ids!.map((id) => ({ method: 'events.getOne', params: { id } })));
    events = got.filter((r: any) => r?.event).map((r: any) => r.event);
  }
  if (events.length === 0) return { content: [{ type: 'text', text: 'No matching events: nothing to delete.' }] };

  const ordered = citingFirst(events);
  const trashed = ordered.filter((e) => e.trashed).length;
  const sample = ordered.slice(0, 10).map((e) => `  - ${e.id} ${e.type}${e.clientData?.sourceKey ? ` ${e.clientData.sourceKey}` : ''}${e.trashed ? ' (in trash: deletes for good)' : ''}`);
  const listing = `${ordered.length} event(s), ${trashed} already in the trash` +
    (sourceKeyPrefix && ordered.length === 1000 ? ' (first 1000 only: run again after deleting)' : '') +
    ':\n' + sample.join('\n') + (ordered.length > 10 ? `\n  ... and ${ordered.length - 10} more` : '');

  if (confirm !== true) {
    return {
      content: [{
        type: 'text',
        text: `Dry run, nothing deleted. Would delete ${listing}\nShow this to the user; call again with confirm: true only if they agree.`
      }]
    };
  }
  const results = await apiBatch(ordered.map((e) => ({ method: 'events.delete', params: { id: e.id } })));
  let toTrash = 0;
  let forGood = 0;
  const errors: string[] = [];
  results.forEach((r: any, i: number) => {
    if (r?.eventDeletion) forGood++;
    else if (r?.event) toTrash++;
    else errors.push(`${ordered[i].id}: ${r?.error?.message ?? r?.error?.id ?? 'unexpected response'}`);
  });
  return {
    content: [{
      type: 'text',
      text: `Deleted: ${toTrash} moved to the trash, ${forGood} removed for good.` +
        (errors.length ? `\n${errors.length} failed:\n  - ${errors.slice(0, 10).join('\n  - ')}` : '')
    }]
  };
}
