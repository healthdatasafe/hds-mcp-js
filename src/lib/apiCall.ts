import { getApiEndpoint } from '../auth/session.ts';
import { assertWriteAllowed } from './hostPolicy.ts';

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
  const res = await fetch(url, {
    headers: { Authorization: token }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body as any)?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Pryv ${path} failed: ${msg}`);
  }
  return body;
}

export async function apiPost (path: string, body: unknown): Promise<any> {
  const apiEndpoint = getApiEndpoint();
  assertWriteAllowed(apiEndpoint);
  const { token, baseUrl } = parseApiEndpoint(apiEndpoint);
  const url = new URL(stripLeadingSlash(path), baseUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: token, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const respBody = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (respBody as any)?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Pryv POST ${path} failed: ${msg}`);
  }
  return respBody;
}

export async function apiBatch (
  calls: Array<{ method: string; params: any }>
): Promise<any[]> {
  const apiEndpoint = getApiEndpoint();
  const writes = calls.filter((c) => !c.method.endsWith('.get') && !c.method.endsWith('.getOne'));
  if (writes.length > 0) assertWriteAllowed(apiEndpoint);
  const { token, baseUrl } = parseApiEndpoint(apiEndpoint);
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { Authorization: token, 'content-type': 'application/json' },
    body: JSON.stringify(calls)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body as any)?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Pryv batch failed: ${msg}`);
  }
  return (body as any).results ?? [];
}

function stripLeadingSlash (p: string): string {
  return p.startsWith('/') ? p.slice(1) : p;
}
