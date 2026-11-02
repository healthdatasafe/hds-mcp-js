import { z } from 'zod';
import { loadPack } from '../dataModel/pack.ts';
import { itemEventTypes, contentSchema, packLabel } from '../dataModel/eventTypes.ts';

export const getItemInput = {
  key: z.string().min(1).describe(
    'The HDS item key, e.g. "body-weight", "body-temperature-basal", "body-vulva-bleeding". ' +
    'Use search_items to discover keys.'
  )
};

export async function getItemHandler (
  { key }: { key: string }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const pack = await loadPack();
  const item = pack.items[key];
  if (!item) {
    const close = Object.keys(pack.items).filter((k) => k.includes(key.split('-')[0] ?? '')).slice(0, 5);
    const hint = close.length > 0 ? `\nDid you mean one of: ${close.join(', ')}?` : '';
    throw new Error(`No HDS item found for key "${key}".${hint}`);
  }
  const eventTypes = itemEventTypes(item);
  const schemas: Record<string, unknown> = {};
  for (const t of eventTypes) schemas[t] = contentSchema(pack, t) ?? null;
  return {
    content: [{
      type: 'text',
      text: `**${key}** — streamId: \`${item.streamId}\` · eventType: ${eventTypes.map((t) => `\`${t}\``).join(' or ')} · type: \`${item.type}\` · ${packLabel(pack)}`
    }, {
      type: 'text',
      text: '```json\n' + JSON.stringify(item, null, 2) + '\n```'
    }, {
      type: 'text',
      text: 'Content schema per eventType (JSON Schema draft-04; create_event and import_batch check content against it before writing):\n' +
        '```json\n' + JSON.stringify(schemas, null, 2) + '\n```'
    }]
  };
}
