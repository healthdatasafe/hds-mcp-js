import { z } from 'zod';
import { apiGet } from '../lib/apiCall.ts';

export const listStreamsInput = {
  parentId: z.string().optional().describe(
    'If set, list only children of this stream. Otherwise lists from the root.'
  )
};

export async function listStreamsHandler (
  { parentId }: { parentId?: string }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const body = await apiGet('/streams', parentId ? { parentId } : undefined);
  const streams = (body as any).streams ?? [];
  const summary = summarizeTree(streams);
  return {
    content: [{
      type: 'text',
      text: `Streams (${countLeaves(streams)} total):\n${summary}`
    }, {
      type: 'text',
      text: '```json\n' + JSON.stringify(streams, null, 2) + '\n```'
    }]
  };
}

interface PryvStream {
  id: string;
  name: string;
  children?: PryvStream[];
}

function summarizeTree (streams: PryvStream[], depth = 0): string {
  return streams.map((s) => {
    const indent = '  '.repeat(depth);
    const head = `${indent}- ${s.id} — ${s.name}`;
    const children = s.children?.length
      ? '\n' + summarizeTree(s.children, depth + 1)
      : '';
    return head + children;
  }).join('\n');
}

function countLeaves (streams: PryvStream[]): number {
  return streams.reduce((acc, s) => acc + 1 + countLeaves(s.children ?? []), 0);
}
