import { z } from 'zod';
import { loadPack, localized } from '../dataModel/pack.ts';
import { packLabel } from '../dataModel/eventTypes.ts';

export const listModelStreamsInput = {
  parentId: z.string().optional().describe(
    'Show the children of this stream. Omit for the root streams (the consent units an app asks access to).'
  ),
  lang: z.string().optional().describe('Language for the stream names, e.g. "fr". Defaults to "en".')
};

interface ModelStream {
  id: string;
  name?: string;
  label?: Record<string, string>;
  description?: Record<string, string>;
  role?: string;
  children?: ModelStream[];
}

function findStream (streams: ModelStream[], id: string): ModelStream | undefined {
  for (const s of streams) {
    if (s.id === id) return s;
    const found = findStream(s.children ?? [], id);
    if (found) return found;
  }
  return undefined;
}

function countDescendants (s: ModelStream): number {
  return (s.children ?? []).reduce((n, c) => n + 1 + countDescendants(c), 0);
}

export async function listModelStreamsHandler (
  { parentId, lang }: { parentId?: string; lang?: string }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const pack = await loadPack();
  const roots = (pack.streams ?? []) as ModelStream[];
  let list = roots;
  if (parentId != null) {
    const parent = findStream(roots, parentId);
    if (!parent) throw new Error(`No stream "${parentId}" in the HDS data model (${packLabel(pack)}).`);
    list = parent.children ?? [];
  }
  const itemsPerStream = new Map<string, string[]>();
  for (const [key, item] of Object.entries(pack.items)) {
    if (item.deprecated === true) continue;
    itemsPerStream.set(item.streamId, [...(itemsPerStream.get(item.streamId) ?? []), key]);
  }
  const lines = list.map((s) => {
    const name = s.label ? localized(s.label, lang ?? 'en') : (s.name ?? '');
    const items = itemsPerStream.get(s.id) ?? [];
    const sub = countDescendants(s);
    return `- \`${s.id}\` — ${name}` +
      (s.role ? ` (role: ${s.role})` : '') +
      (sub > 0 ? ` · ${sub} sub-stream(s)` : '') +
      (items.length > 0 ? ` · items: ${items.join(', ')}` : '');
  });
  const title = parentId != null ? `Children of \`${parentId}\`` : 'Root streams of the HDS data model';
  return {
    content: [{
      type: 'text',
      text: `${title} (${packLabel(pack)}), ${list.length} stream(s):\n\n` +
        (lines.length > 0 ? lines.join('\n') : '(none)') +
        '\n\nThese are the model streams, not the user\'s account: use list_streams for what exists in the account.'
    }]
  };
}
