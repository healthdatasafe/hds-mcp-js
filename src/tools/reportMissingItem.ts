import { z } from 'zod';

const NEW_ISSUE = 'https://github.com/healthdatasafe/site-agents/issues/new';
// GitHub refuses very long prefilled URLs; the report is a few lines anyway.
const MAX_URL = 6000;

export const reportMissingItemInput = {
  kind: z.string().min(3).max(120).describe(
    'The kind of data no HDS item fits, in a few words (e.g. "serum ferritin", "pelvic floor exercise log"). ' +
    'Never the person\'s value, name, date or anything that identifies them.'
  ),
  source: z.string().max(200).optional().describe(
    'Where this kind of data comes from (e.g. "printed lab report", "Apple Health export", "spreadsheet"). No file names.'
  ),
  unit: z.string().max(40).optional().describe('The unit as printed, if any (e.g. "µg/L").'),
  codes: z.array(z.string().max(60)).max(10).optional().describe(
    'Terminology codes you know for it (e.g. "LOINC 2276-4", "SNOMED 102271003"). Verified codes only.'
  ),
  workaround: z.string().max(200).optional().describe(
    'What was done meanwhile (e.g. "kept aside, not stored", "stored as lab-result/coded-v1").'
  )
};

type Input = { kind: string; source?: string; unit?: string; codes?: string[]; workaround?: string };

/**
 * A prefilled GitHub issue link (site-agents, data-model-gap template) for the person to open and post: HDS files
 * nothing itself (plan 118 D-J1). The report carries the kind of data, never the person's data.
 */
export async function reportMissingItemHandler (
  { kind, source, unit, codes, workaround }: Input
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const body = [
    '**What data were you trying to record or import?**',
    [kind, source ? `from ${source}` : '', unit ? `(unit: ${unit})` : ''].filter(Boolean).join(' '),
    '',
    '**What did you / your agent end up doing?**',
    workaround ?? 'Not stored yet.',
    '',
    '**Anything you know about how it should map?**',
    codes?.length ? codes.join(', ') : '(no codes known)',
    '',
    '_Prepared by the HDS MCP. It contains no personal data: please check before posting._'
  ].join('\n');
  const url = new URL(NEW_ISSUE);
  url.searchParams.set('template', 'data-model-gap.md');
  url.searchParams.set('labels', 'data-model-gap');
  url.searchParams.set('title', `Data model gap: ${kind}`);
  url.searchParams.set('body', body);
  if (url.href.length > MAX_URL) throw new Error('report too long: shorten kind, source or workaround');
  return {
    content: [{
      type: 'text',
      text: 'Give the person this link. It opens a prefilled report on GitHub (a free GitHub account is needed, ' +
        'see https://agents.datasafe.dev/feedback); they read it and post it themselves. Nothing has been sent.\n\n' +
        url.href
    }]
  };
}
