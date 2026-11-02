import { z } from 'zod';
import { apiBatch } from '../lib/apiCall.ts';
import { loadPack, localized } from '../dataModel/pack.ts';

export const ensureStreamsInput = {
  items: z.array(z.string().min(1)).min(1).max(100).describe(
    'HDS item keys (from search_items) whose streams must exist before writing, e.g. ["body-weight"]. ' +
    'Missing streams are created with their data-model names, parents first. Needs manage on the root.'
  )
};

interface ModelStream { id: string; name?: string; label?: Record<string, string>; children?: ModelStream[] }

/** Path from the root to `id` in the model tree, or undefined. */
export function modelPath (streams: ModelStream[], id: string, trail: ModelStream[] = []): ModelStream[] | undefined {
  for (const s of streams) {
    const here = [...trail, s];
    if (s.id === id) return here;
    const found = modelPath(s.children ?? [], id, here);
    if (found) return found;
  }
  return undefined;
}

function collectIds (streams: Array<{ id: string; children?: any[] }>, out = new Set<string>()): Set<string> {
  for (const s of streams) {
    out.add(s.id);
    collectIds(s.children ?? [], out);
  }
  return out;
}

export async function ensureStreamsHandler (
  { items }: { items: string[] }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const pack = await loadPack();
  const toCreate: Array<{ id: string; name: string; parentId: string | null }> = [];
  const planned = new Set<string>();
  for (const key of items) {
    const item = pack.items[key];
    if (!item) throw new Error(`No HDS item found for key "${key}".`);
    const path = modelPath((pack.streams ?? []) as ModelStream[], item.streamId);
    if (!path) throw new Error(`Stream "${item.streamId}" of item "${key}" is not in the data-model stream tree.`);
    path.forEach((s, i) => {
      if (planned.has(s.id)) return;
      planned.add(s.id);
      toCreate.push({ id: s.id, name: s.label ? localized(s.label, 'en') : (s.name ?? s.id), parentId: i === 0 ? null : path[i - 1].id });
    });
  }

  const [got] = await apiBatch([{ method: 'streams.get', params: { state: 'all' } }]);
  if (got?.error) throw new Error(`Pryv streams.get failed: ${got.error.message ?? got.error.id}`);
  const existing = collectIds(got?.streams ?? []);
  const missing = toCreate.filter((s) => !existing.has(s.id));
  if (missing.length === 0) {
    return { content: [{ type: 'text', text: `All streams already exist for: ${items.join(', ')}.` }] };
  }
  const results = await apiBatch(missing.map((s) => ({ method: 'streams.create', params: s })));
  const created: string[] = [];
  const failed: string[] = [];
  results.forEach((r: any, i: number) => {
    if (r?.stream) created.push(missing[i].id);
    else failed.push(`${missing[i].id}: ${r?.error?.message ?? r?.error?.id ?? 'unexpected response'}`);
  });
  return {
    content: [{
      type: 'text',
      text: `Created ${created.length} stream(s)${created.length ? `: ${created.join(', ')}` : ''}.` +
        (failed.length ? `\n${failed.length} failed:\n  - ${failed.join('\n  - ')}` : '')
    }]
  };
}
