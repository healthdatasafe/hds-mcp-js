import { loadPack, en } from '../dataModel/pack.ts';
import type { DataModelPack } from '../dataModel/pack.ts';
import { packLabel } from '../dataModel/eventTypes.ts';
import type { DatasourceDef } from '../dataModel/datasources.ts';

export const listDatasourcesInput = {};

/**
 * The active items that take a value from a datasource: on the item itself (condition-coded) or on one of its
 * composite fields (allergy-coded's `allergen`).
 */
export function itemsUsingDatasource (pack: DataModelPack, key: string): string[] {
  return Object.entries(pack.items)
    .filter(([, item]) => item.deprecated !== true && (item.datasource === key ||
      Object.values((item.composite ?? {}) as Record<string, { datasource?: string }>)
        .some((field) => field?.datasource === key)))
    .map(([k]) => k);
}

export async function listDatasourcesHandler (): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const pack = await loadPack();
  const datasources = (pack.datasources ?? {}) as Record<string, DatasourceDef>;
  const lines = Object.entries(datasources).map(([key, ds]) => {
    const items = itemsUsingDatasource(pack, key);
    return `- **${key}** — ${en(ds.label)}: ${en(ds.description)}\n` +
      `  search with search_dataset (at least ${ds.minQueryLength} characters)` +
      (items.length > 0 ? ` · used by items: ${items.join(', ')}` : '');
  });
  return {
    content: [{
      type: 'text',
      text: `Datasources of the HDS data model (${packLabel(pack)}):\n\n` + lines.join('\n') +
        '\n\nA datasource-search item stores the chosen entry, as search_dataset returns it, in a coded property ' +
        'of its content: call search_dataset, then get_item / get_event_type for the content shape. ' +
        'manifestation is used by no item field: its entries go in an allergy\'s content.reactions[].manifestations.'
    }]
  };
}
