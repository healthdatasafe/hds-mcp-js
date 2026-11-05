import { z } from 'zod';
import { version } from '../server.ts';

const NEW_ISSUE = 'https://github.com/healthdatasafe/site-agents/issues/new';
const MAX_URL = 6000;

export const reportProblemInput = {
  asked: z.string().min(3).max(300).describe('What the person asked you to do, in a sentence. No health data.'),
  happened: z.string().min(3).max(1200).describe(
    'What went wrong: the tool that failed and its error message as-is. Leave out the person\'s data, names, account name and links.'
  ),
  client: z.string().max(80).optional().describe('The AI client (e.g. "Claude.ai web", "ChatGPT", "Claude Code").'),
  step: z.enum(['connect', 'reading data', 'writing data', 'other']).optional()
};

type Input = { asked: string; happened: string; client?: string; step?: string };

/**
 * A prefilled "Agent problem" issue link (site-agents) for the person to open and post: HDS files nothing itself.
 * The counterpart of report_missing_item for problems with the connector rather than gaps in the data model.
 */
export async function reportProblemHandler (
  { asked, happened, client, step }: Input
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const body = [
    '**What did you ask your agent to do?**', asked, '',
    '**What happened instead?**', happened, '',
    '**Setup**',
    `- AI client: ${client ?? '(not given)'}`,
    `- HDS MCP: ${version}`,
    `- Where it failed: ${step ?? 'other'}`, '',
    '_Prepared by the HDS MCP. Please check it holds no personal data before posting._'
  ].join('\n');
  const url = new URL(NEW_ISSUE);
  url.searchParams.set('template', 'agent-problem.md');
  url.searchParams.set('labels', 'agent-problem');
  url.searchParams.set('title', `MCP problem: ${asked.slice(0, 80)}`);
  url.searchParams.set('body', body);
  if (url.href.length > MAX_URL) throw new Error('report too long: shorten what happened');
  return {
    content: [{
      type: 'text',
      text: 'Give the person this link. It opens a prefilled problem report on GitHub (a free GitHub account is needed, ' +
        'see https://agents.datasafe.dev/feedback); they read it and post it themselves. Nothing has been sent.\n\n' + url.href
    }]
  };
}
