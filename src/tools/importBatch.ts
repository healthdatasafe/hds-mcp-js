import { z } from 'zod';
import { apiBatch } from '../lib/apiCall.ts';
import { loadPack } from '../dataModel/pack.ts';
import { validateEvent } from '../dataModel/eventTypes.ts';

const eventSchema = z.object({
  streamIds: z.array(z.string()).min(1),
  type: z.string(),
  content: z.unknown().optional(),
  time: z.number().optional(),
  duration: z.number().nonnegative().optional(),
  tags: z.array(z.string()).optional(),
  description: z.string().optional(),
  clientData: z.record(z.string(), z.unknown()).optional()
});

export const importBatchInput = {
  events: z.array(eventSchema).min(1).max(500).describe(
    'Events to import. 1–500 per call. Each must have streamIds and type — ' +
    'use the values from get_item for the matching HDS item (call search_items first). ' +
    'content must match the eventType content schema from get_item; description and clientData ' +
    'are optional and follow the data-model conventions (e.g. clientData.sourceKey for provenance).'
  )
};

export async function importBatchHandler (
  args: { events: z.infer<typeof eventSchema>[] }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const pack = await loadPack();
  const invalid: string[] = [];
  args.events.forEach((ev, i) => {
    for (const p of validateEvent(pack, ev.type, ev.content)) invalid.push(`  - [${i}] ${p}`);
  });
  if (invalid.length > 0) {
    throw new Error(
      `Batch refused, nothing written: ${invalid.length} problem(s).\n` +
      invalid.slice(0, 20).join('\n') +
      (invalid.length > 20 ? `\n  ... and ${invalid.length - 20} more` : '')
    );
  }

  const calls = args.events.map((ev) => ({
    method: 'events.create',
    params: ev
  }));
  const results = await apiBatch(calls);

  let created = 0;
  let failed = 0;
  const ids: Array<string | null> = [];
  const errors: Array<{ index: number; message: string }> = [];
  args.events.forEach((_ev, i) => {
    const r: any = results[i];
    if (r?.error) {
      failed++;
      ids.push(null);
      errors.push({ index: i, message: r.error.message ?? 'unknown error' });
    } else if (r?.event) {
      created++;
      ids.push(r.event.id ?? null);
    } else {
      failed++;
      ids.push(null);
      errors.push({ index: i, message: 'unexpected response shape' });
    }
  });

  const lines: string[] = [
    `Imported ${created}/${args.events.length} events.`
  ];
  if (failed > 0) {
    lines.push(`${failed} failed:`);
    for (const e of errors.slice(0, 10)) {
      lines.push(`  - [${e.index}] ${e.message}`);
    }
    if (errors.length > 10) lines.push(`  ... and ${errors.length - 10} more`);
  }
  lines.push('Event ids, in input order (null = not created):');
  lines.push('```json\n' + JSON.stringify(ids) + '\n```');
  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
}
