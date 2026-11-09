import { z } from 'zod';
import { loadPack } from '../dataModel/pack.ts';
import { packLabel } from '../dataModel/eventTypes.ts';
import { datasourceDef, resolveEndpoint } from '../dataModel/datasources.ts';
import { policyFetch, UpstreamError } from '../lib/fetchPolicy.ts';

export const searchDatasetInput = {
  datasource: z.string().min(1).describe(
    'The datasource key from list_datasources: "condition", "finding", "medication", "procedure", "treatment".'
  ),
  query: z.string().min(1).describe(
    'Search text (at least 3 characters), e.g. "endometriosis", "metformin". ' +
    'Sent to the HDS datasets service of the connected platform (demo when not connected).'
  ),
  limit: z.number().int().positive().max(50).optional().describe('Max entries to return. Default 20.')
};

export async function searchDatasetHandler (
  { datasource, query, limit }: { datasource: string; query: string; limit?: number }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const pack = await loadPack();
  const ds = datasourceDef(pack, datasource);
  if (!ds) {
    const keys = Object.keys(pack.datasources ?? {}).join(', ');
    throw new Error(`No datasource "${datasource}" in ${packLabel(pack)}. Available: ${keys}.`);
  }
  if (query.trim().length < ds.minQueryLength) {
    throw new Error(`Search text too short for "${datasource}": at least ${ds.minQueryLength} characters.`);
  }
  const url = new URL(await resolveEndpoint(ds.endpoint));
  url.searchParams.set(ds.queryParam, query.trim());
  const res = await policyFetch(url);
  const body = await res.json().catch(() => ({})) as Record<string, any>;
  if (!res.ok) {
    throw new UpstreamError(`Dataset search failed: ${body?.error?.message ?? body?.message ?? `HTTP ${res.status}`}`, res.status);
  }
  const all: any[] = Array.isArray(body[ds.resultKey]) ? body[ds.resultKey] : [];
  const fields = ds.valueFields ?? ['label', 'description', 'codes', 'hdsId'];
  const entries = all.slice(0, limit ?? 20).map((e) => {
    const out: Record<string, unknown> = {};
    for (const f of fields) if (e[f] != null) out[f] = e[f];
    return out;
  });
  if (entries.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No "${datasource}" entries matched "${query}". The datasets are curated and may not hold every concept: ` +
          'tell the user, and do not invent a code.'
      }]
    };
  }
  return {
    content: [{
      type: 'text',
      text: `${all.length} "${datasource}" entr${all.length === 1 ? 'y' : 'ies'} matched "${query}"` +
        (all.length > entries.length ? ` (showing ${entries.length})` : '') +
        '. Copy the chosen entry\'s label, description and codes, unchanged, into the coded property of the ' +
        'item\'s content (e.g. content.condition, content.drug, content.regimen: see get_event_type for the shape). ' +
        'Never edit or invent codes.'
    }, {
      type: 'text',
      text: '```json\n' + JSON.stringify(entries, null, 2) + '\n```'
    }]
  };
}
