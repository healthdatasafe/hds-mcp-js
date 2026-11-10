import { getApiEndpoint, getProdWritesEnabled } from '../auth/session.ts';
import { assertWriteAllowed } from './hostPolicy.ts';
import { policyFetch, TIMEOUT_MS, UpstreamError } from './fetchPolicy.ts';

interface ParsedEndpoint {
  token: string;
  baseUrl: string;
}

function parseApiEndpoint (apiEndpoint: string): ParsedEndpoint {
  const url = new URL(apiEndpoint);
  const token = url.username;
  url.username = '';
  url.password = '';
  let base = url.toString();
  if (!base.endsWith('/')) base += '/';
  return { token, baseUrl: base };
}

export async function apiGet (path: string, query?: Record<string, unknown>): Promise<any> {
  const { token, baseUrl } = parseApiEndpoint(getApiEndpoint());
  const url = new URL(stripLeadingSlash(path), baseUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, String(item));
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }
  const res = await policyFetch(url, {
    headers: { Authorization: token }
  }, TIMEOUT_MS.api);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body as any)?.error?.message ?? `HTTP ${res.status}`;
    throw new UpstreamError(`Pryv ${path} failed: ${msg}`, res.status, (body as any)?.error?.id);
  }
  return body;
}

export async function apiPost (path: string, body: unknown): Promise<any> {
  const apiEndpoint = getApiEndpoint();
  assertWriteAllowed(apiEndpoint, getProdWritesEnabled());
  const { token, baseUrl } = parseApiEndpoint(apiEndpoint);
  const url = new URL(stripLeadingSlash(path), baseUrl);
  const res = await policyFetch(url, {
    method: 'POST',
    headers: { Authorization: token, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }, TIMEOUT_MS.api);
  const respBody = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (respBody as any)?.error?.message ?? `HTTP ${res.status}`;
    throw new UpstreamError(`Pryv POST ${path} failed: ${msg}`, res.status, (respBody as any)?.error?.id);
  }
  return respBody;
}

export async function apiBatch (
  calls: Array<{ method: string; params: any }>
): Promise<any[]> {
  const apiEndpoint = getApiEndpoint();
  const writes = calls.filter((c) => !c.method.endsWith('.get') && !c.method.endsWith('.getOne'));
  if (writes.length > 0) assertWriteAllowed(apiEndpoint, getProdWritesEnabled());
  const { token, baseUrl } = parseApiEndpoint(apiEndpoint);
  const res = await policyFetch(baseUrl, {
    method: 'POST',
    headers: { Authorization: token, 'content-type': 'application/json' },
    body: JSON.stringify(calls)
  }, TIMEOUT_MS.api);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body as any)?.error?.message ?? `HTTP ${res.status}`;
    throw new UpstreamError(`Pryv batch failed: ${msg}`, res.status, (body as any)?.error?.id);
  }
  return (body as any).results ?? [];
}

function stripLeadingSlash (p: string): string {
  return p.startsWith('/') ? p.slice(1) : p;
}
