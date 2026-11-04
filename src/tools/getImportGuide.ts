import { z } from 'zod';
import { GUIDE_TOPICS, GUIDES } from '../guides/content.ts';

export const getImportGuideInput = {
  topic: z.enum(GUIDE_TOPICS).optional().describe(
    "'overview' (default: the whole journey, read it first), or one source type: 'lab-report', 'letter', " +
    "'photo', 'spreadsheet', 'app-export', or 'missing-item' (when no HDS item fits)."
  )
};

export async function getImportGuideHandler (
  { topic }: { topic?: typeof GUIDE_TOPICS[number] }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  return { content: [{ type: 'text', text: GUIDES[topic ?? 'overview'] }] };
}
