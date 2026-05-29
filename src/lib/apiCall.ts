import { getApiEndpoint } from '../auth/session.ts';

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

function stripLeadingSlash (p: string): string {
  return p.startsWith('/') ? p.slice(1) : p;
}
