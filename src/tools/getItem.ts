import { z } from 'zod';
import { loadPack } from '../dataModel/pack.ts';

export const getItemInput = {
  key: z.string().min(1).describe(
    'The HDS item key, e.g. "body-weight", "fertility-bbt", "body-vulva-bleeding". ' +
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
  return {
    content: [{
      type: 'text',
      text: `**${key}** — streamId: \`${item.streamId}\` · eventType: \`${item.eventType}\` · type: \`${item.type}\``
    }, {
      type: 'text',
      text: '```json\n' + JSON.stringify(item, null, 2) + '\n```'
    }]
  };
}
