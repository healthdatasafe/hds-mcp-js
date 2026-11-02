import { z } from 'zod';
import { apiBatch } from '../lib/apiCall.ts';
import { loadPack } from '../dataModel/pack.ts';
import { validateEvent } from '../dataModel/eventTypes.ts';

export const updateEventInput = {
  id: z.string().min(1).describe('The event id (from get_events, or returned by create_event / import_batch).'),
  update: z.object({
    content: z.unknown().optional(),
    type: z.string().optional(),
    time: z.number().optional(),
    duration: z.number().nonnegative().optional(),
    description: z.string().optional(),
    clientData: z.record(z.string(), z.unknown()).optional(),
    tags: z.array(z.string()).optional()
  }).describe(
    'Fields to change. clientData replaces the whole clientData object: send every key to keep ' +
    '(e.g. sourceKey). Content is checked against the event type before writing.'
  )
};

export async function updateEventHandler (
  { id, update }: { id: string; update: Record<string, unknown> & { content?: unknown; type?: string } }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (Object.keys(update).length === 0) throw new Error('Nothing to update.');
  if ('content' in update || 'type' in update) {
    const [cur] = await apiBatch([{ method: 'events.getOne', params: { id } }]);
    if (cur?.error) throw new Error(`Pryv events.getOne failed: ${cur.error.message ?? cur.error.id}`);
    const type = update.type ?? cur.event.type;
    const content = 'content' in update ? update.content : cur.event.content;
    const problems = validateEvent(await loadPack(), type, content);
    if (problems.length > 0) throw new Error(`Update refused, nothing written: ${problems.join('; ')}`);
  }
  const [res] = await apiBatch([{ method: 'events.update', params: { id, update } }]);
  if (res?.error) throw new Error(`Pryv events.update failed: ${res.error.message ?? res.error.id}`);
  return {
    content: [{ type: 'text', text: `Updated event ${id}.` }, {
      type: 'text',
      text: '```json\n' + JSON.stringify(res.event, null, 2) + '\n```'
    }]
  };
}
