import { SERVICE_INFO } from '../lib/hostPolicy.ts';
import { getServiceInfoUrl } from '../auth/session.ts';
import type { DataModelPack } from './pack.ts';

export interface DatasourceDef {
  label?: Record<string, string>;
  description?: Record<string, string>;
  endpoint: string;
  queryParam: string;
  minQueryLength: number;
  resultKey: string;
  valueFields?: string[];
}

const assetsCache = new Map<string, Record<string, string>>();

async function serviceAssets (serviceInfoUrl: string): Promise<Record<string, string>> {
  const cached = assetsCache.get(serviceInfoUrl);
  if (cached) return cached;
  const res = await fetch(serviceInfoUrl);
  if (!res.ok) throw new Error(`service-info fetch failed: HTTP ${res.status}`);
  const assets = ((await res.json()) as { assets?: Record<string, string> }).assets ?? {};
  assetsCache.set(serviceInfoUrl, assets);
  return assets;
}

export function datasourceDef (pack: DataModelPack, key: string): DatasourceDef | undefined {
  return pack.datasources?.[key];
}

/**
 * Resolves a datasource endpoint the way hds-lib does: an `http` endpoint is used as is,
 * `<asset>://<path>` is joined to the `assets.<asset>` URL of the platform's service-info.
 * The platform is the connected one, else demo (the MCP default).
 */
export async function resolveEndpoint (endpoint: string): Promise<string> {
  if (endpoint.startsWith('http')) return endpoint;
  const sep = endpoint.indexOf('://');
  if (sep === -1) return endpoint;
  const assetKey = endpoint.substring(0, sep);
  const path = endpoint.substring(sep + 3);
  const serviceInfoUrl = getServiceInfoUrl() ?? SERVICE_INFO.demo;
  const base = (await serviceAssets(serviceInfoUrl))[assetKey];
  if (!base) throw new Error(`Cannot resolve datasource endpoint "${endpoint}": no asset "${assetKey}" in service-info`);
  return base.endsWith('/') ? base + path : base + '/' + path;
}
