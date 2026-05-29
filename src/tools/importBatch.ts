import { z } from 'zod';
import { apiBatch } from '../lib/apiCall.ts';

const eventSchema = z.object({
  streamIds: z.array(z.string()).min(1),
  type: z.string(),
  content: z.unknown().optional(),
  time: z.number().optional(),
  duration: z.number().nonnegative().optional(),
  tags: z.array(z.string()).optional()
});

export const importBatchInput = {
  events: z.array(eventSchema).min(1).max(500).describe(
    'Events to import. 1–500 per call. Each must have streamIds and type.'
  )
};

export async function importBatchHandler (
  args: { events: z.infer<typeof eventSchema>[] }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const calls = args.events.map((ev) => ({
    method: 'events.create',
    params: ev
  }));
  const results = await apiBatch(calls);

  let created = 0;
  let failed = 0;
  const errors: Array<{ index: number; message: string }> = [];
  results.forEach((r: any, i: number) => {
    if (r?.error) {
      failed++;
      errors.push({ index: i, message: r.error.message ?? 'unknown error' });
    } else if (r?.event) {
      created++;
    } else {
      failed++;
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
  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
}
