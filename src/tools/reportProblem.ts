import { z } from 'zod';
import { version } from '../server.ts';
import { getApiEndpoint, isConnected } from '../auth/session.ts';
import { scrubReport } from '../lib/scrubber.ts';

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

/** The connected account's name (`<username>.<platform domain>/` or `<host>/<username>/`), to keep it out of the report. */
function connectedUsername (): string | null {
  try {
    if (!isConnected()) return null;
    const url = new URL(getApiEndpoint());
    const labels = url.hostname.split('.');
    if (labels.length >= 4) return labels[0];
    return url.pathname.split('/').filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * A prefilled "Agent problem" issue link (site-agents) for the person to open and post: HDS files nothing itself.
 * The counterpart of report_missing_item for problems with the connector rather than gaps in the data model.
 */
export async function reportProblemHandler (
  input: Input
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  // Every free-text field: the link opens an issue on a public repo (B-2026-11-09-10).
  const opts = { username: connectedUsername() };
  const asked = scrubReport(input.asked, opts);
  const happened = scrubReport(input.happened, opts);
  const client = input.client == null ? undefined : scrubReport(input.client, opts);
  const step = input.step;
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
