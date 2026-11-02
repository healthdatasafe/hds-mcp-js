import { z } from 'zod';
import { loadPack, localized, type ItemDef } from '../dataModel/pack.ts';
import { itemEventTypes, packLabel } from '../dataModel/eventTypes.ts';
import { itemCodes, formatCodes } from '../dataModel/codes.ts';

export const searchItemsInput = {
  query: z.string().min(1).describe(
    'Search text, in any language the data model has labels for (English, French; a few Spanish). ' +
    'Matches item key, label, description, streamId, eventType, and terminology codes: ' +
    'a LOINC or SNOMED-CT code (e.g. "29463-7") finds the item that owns it. Case-insensitive.'
  ),
  limit: z.number().int().positive().max(50).optional().describe(
    'Max number of matches to return. Default 20.'
  ),
  lang: z.string().optional().describe(
    'Language for the labels shown, e.g. "fr". Defaults to "en"; falls back to English when missing.'
  ),
  includeDeprecated: z.boolean().optional().describe(
    'Also return deprecated items (never write new data to them). Default false.'
  )
};

interface Match {
  key: string;
  label: string;
  description: string;
  streamId: string;
  eventType: string;
  type: string;
  codes: string;
  deprecated: boolean;
  score: number;
}

export async function searchItemsHandler (
  { query, limit, lang, includeDeprecated }: { query: string; limit?: number; lang?: string; includeDeprecated?: boolean }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const pack = await loadPack();
  const q = query.toLowerCase().trim();
  const cap = limit ?? 20;
  const showLang = lang ?? 'en';

  const matches: Match[] = [];
  for (const [key, item] of Object.entries(pack.items)) {
    const deprecated = item.deprecated === true;
    if (deprecated && includeDeprecated !== true) continue;
    const score = scoreItem(key, item, q);
    if (score > 0) {
      matches.push({
        key,
        label: localized(item.label, showLang),
        description: localized(item.description, showLang),
        streamId: item.streamId,
        eventType: itemEventTypes(item).join(' | '),
        type: item.type,
        codes: formatCodes(itemCodes(item)),
        deprecated,
        score
      });
    }
  }
  matches.sort((a, b) => b.score - a.score);
  const top = matches.slice(0, cap);

  if (top.length === 0) {
    return {
      content: [{ type: 'text', text: `No HDS items matched "${query}" (${packLabel(pack)}).` }]
    };
  }

  const lines = top.map((m) =>
    `- **${m.key}** (${m.type})${m.deprecated ? ' DEPRECATED' : ''} — ${m.label || '(no label)'}\n` +
    `  stream: \`${m.streamId}\` · eventType: \`${m.eventType}\`\n` +
    (m.codes ? `  codes: ${m.codes}\n` : '') +
    (m.description ? `  ${m.description}\n` : '')
  );
  return {
    content: [{
      type: 'text',
      text: `Found ${matches.length} item(s) matching "${query}"` +
        (matches.length > top.length ? ` (showing top ${top.length})` : '') +
        ` in ${packLabel(pack)}:\n\n` + lines.join('\n')
    }]
  };
}

export function scoreItem (key: string, item: ItemDef, q: string): number {
  let score = 0;
  if (key.toLowerCase() === q) score += 100;
  if (key.toLowerCase().includes(q)) score += 30;
  if (itemCodes(item).some((c) => c.code.toLowerCase() === q)) score += 90;
  const labels = Object.values(item.label ?? {}).map((l) => l.toLowerCase());
  if (labels.some((l) => l === q)) score += 80;
  if (labels.some((l) => l.includes(q))) score += 20;
  if (Object.values(item.description ?? {}).some((d) => d.toLowerCase().includes(q))) score += 5;
  if (item.streamId.toLowerCase().includes(q)) score += 10;
  if (itemEventTypes(item).some((t) => t.toLowerCase().includes(q))) score += 10;
  return score;
}
