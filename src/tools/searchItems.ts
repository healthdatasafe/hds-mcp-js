import { z } from 'zod';
import { loadPack, en, type ItemDef } from '../dataModel/pack.ts';

export const searchItemsInput = {
  query: z.string().min(1).describe(
    'Search text. Matches item key, label, description, streamId, and eventType (case-insensitive).'
  ),
  limit: z.number().int().positive().max(50).optional().describe(
    'Max number of matches to return. Default 20.'
  )
};

interface Match {
  key: string;
  label: string;
  description: string;
  streamId: string;
  eventType: string;
  type: string;
  score: number;
}

export async function searchItemsHandler (
  { query, limit }: { query: string; limit?: number }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const pack = await loadPack();
  const q = query.toLowerCase();
  const cap = limit ?? 20;

  const matches: Match[] = [];
  for (const [key, item] of Object.entries(pack.items)) {
    const score = scoreItem(key, item, q);
    if (score > 0) {
      matches.push({
        key,
        label: en(item.label),
        description: en(item.description),
        streamId: item.streamId,
        eventType: item.eventType,
        type: item.type,
        score
      });
    }
  }
  matches.sort((a, b) => b.score - a.score);
  const top = matches.slice(0, cap);

  if (top.length === 0) {
    return {
      content: [{ type: 'text', text: `No HDS items matched "${query}".` }]
    };
  }

  const lines = top.map((m) =>
    `- **${m.key}** (${m.type}) — ${m.label || '(no label)'}\n` +
    `  stream: \`${m.streamId}\` · eventType: \`${m.eventType}\`\n` +
    (m.description ? `  ${m.description}\n` : '')
  );
  return {
    content: [{
      type: 'text',
      text: `Found ${matches.length} item(s) matching "${query}"` +
        (matches.length > top.length ? ` (showing top ${top.length})` : '') +
        ':\n\n' + lines.join('\n')
    }]
  };
}

function scoreItem (key: string, item: ItemDef, q: string): number {
  let score = 0;
  if (key.toLowerCase() === q) score += 100;
  if (key.toLowerCase().includes(q)) score += 30;
  const label = en(item.label).toLowerCase();
  if (label === q) score += 80;
  if (label.includes(q)) score += 20;
  const desc = en(item.description).toLowerCase();
  if (desc.includes(q)) score += 5;
  if (item.streamId.toLowerCase().includes(q)) score += 10;
  if (item.eventType.toLowerCase().includes(q)) score += 10;
  return score;
}
