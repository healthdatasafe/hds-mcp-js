import { z } from 'zod';
import { loadPack, en } from '../dataModel/pack.ts';
import { contentSchema, itemEventTypes, packLabel } from '../dataModel/eventTypes.ts';

export const getEventTypeInput = {
  type: z.string().min(1).describe(
    'The eventType, e.g. "mass/kg", "lab-result/coded-v1", "file/xds-v1". ' +
    'Use the eventType returned by search_items or get_item.'
  )
};

export async function getEventTypeHandler (
  { type }: { type: string }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const pack = await loadPack();
  const schema = contentSchema(pack, type);
  if (!schema) {
    throw new Error(`No HDS event type "${type}" in ${packLabel(pack)}. Use search_items to find the item, then its eventType.`);
  }
  const extra = pack.eventTypes?.extras?.[type] as { name?: Record<string, string>; symbol?: string } | undefined;
  const items = Object.entries(pack.items)
    .filter(([, item]) => item.deprecated !== true && itemEventTypes(item).includes(type))
    .map(([key]) => key);
  const head = [
    `**${type}** · ${packLabel(pack)}`,
    extra ? `Unit: ${en(extra.name)}${extra.symbol ? ` (${extra.symbol})` : ''}` : '',
    schema.attachmentRequired === true ? 'Needs an attachment: not writable through this MCP yet.' : '',
    `Items using it: ${items.length > 0 ? items.join(', ') : 'none (a generic type: prefer an item when one fits)'}`
  ].filter((l) => l !== '');
  return {
    content: [{
      type: 'text',
      text: head.join('\n')
    }, {
      type: 'text',
      text: 'Content schema (JSON Schema draft-04; create_event and import_batch check content against it):\n' +
        '```json\n' + JSON.stringify(schema, null, 2) + '\n```'
    }]
  };
}
