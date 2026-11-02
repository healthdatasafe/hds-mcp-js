import { loadPack, en } from '../dataModel/pack.ts';
import { packLabel } from '../dataModel/eventTypes.ts';
import type { DatasourceDef } from '../dataModel/datasources.ts';

export const listDatasourcesInput = {};

export async function listDatasourcesHandler (): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const pack = await loadPack();
  const datasources = (pack.datasources ?? {}) as Record<string, DatasourceDef>;
  const lines = Object.entries(datasources).map(([key, ds]) => {
    const items = Object.entries(pack.items)
      .filter(([, item]) => item.deprecated !== true && item.datasource === key)
      .map(([k]) => k);
    return `- **${key}** — ${en(ds.label)}: ${en(ds.description)}\n` +
      `  search with search_dataset (at least ${ds.minQueryLength} characters)` +
      (items.length > 0 ? ` · used by items: ${items.join(', ')}` : '');
  });
  return {
    content: [{
      type: 'text',
      text: `Datasources of the HDS data model (${packLabel(pack)}):\n\n` + lines.join('\n') +
        '\n\nA datasource-search item stores the chosen entry (label, description, codes) in a coded property ' +
        'of its content: call search_dataset, then get_item / get_event_type for the content shape.'
    }]
  };
}
