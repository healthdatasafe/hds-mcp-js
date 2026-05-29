import { safeLog } from '../lib/scrubber.ts';

const DEFAULT_PACK_URL = 'https://model.datasafe.dev/pack.json';

export interface ItemDef {
  version?: string;
  label?: Record<string, string>;
  description?: Record<string, string>;
  streamId: string;
  eventType: string;
  type: string;
  repeatable?: string;
  unit?: string;
  scale?: unknown;
  options?: unknown;
  [k: string]: unknown;
}

export interface DataModelPack {
  publicationDate?: string;
  items: Record<string, ItemDef>;
  streams?: any;
  eventTypes?: any;
  conversions?: any;
}

let cached: DataModelPack | null = null;
let loadingPromise: Promise<DataModelPack> | null = null;

export async function loadPack (url?: string): Promise<DataModelPack> {
  if (cached) return cached;
  if (loadingPromise) return loadingPromise;
  const packUrl = url ?? DEFAULT_PACK_URL;
  loadingPromise = (async () => {
    safeLog(`Loading HDS data-model pack from ${packUrl}`);
    const res = await fetch(packUrl);
    if (!res.ok) throw new Error(`Failed to load data-model pack: HTTP ${res.status}`);
    const pack = await res.json() as DataModelPack;
    if (!pack.items || typeof pack.items !== 'object') {
      throw new Error('Pack did not contain an `items` object');
    }
    cached = pack;
    safeLog(`Pack loaded: ${Object.keys(pack.items).length} items`);
    return pack;
  })();
  return loadingPromise;
}

export function en (loc: Record<string, string> | undefined): string {
  if (!loc) return '';
  return loc.en ?? Object.values(loc)[0] ?? '';
}
