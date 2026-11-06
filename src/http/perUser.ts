import type { IncomingHttpHeaders } from 'node:http';

/**
 * Per-user addresses (plan 118 PER-USER-ADDRESS.md, open-pryv.io R10 + R11): the MCP is also reached as
 * `https://<username>.<domain><path>`, the person's own API host, so nobody has to know their region. On such a
 * request the core sets `X-Adapter-Name` (the addressed name) and `X-Adapter-Base` (the base the client addressed,
 * e.g. `https://alice.api.datasafe.dev/adapter/mcp/`) and strips client-sent copies; a platform address (the region
 * host) carries neither. The resource, its RFC 9728 metadata, the challenges and the exchange's
 * `subject_token_resource` then come from the base; which name may fill it is the core's to enforce (R10: only the
 * signed-in account), at sign-in and at the token exchange.
 */

// One DNS label: the API host's username part.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface Addressed {
  /** The addressed name (a username, or an address alias): not an identity, the token is. */
  name: string;
  /** The base the client addressed, ending with the adapter base path. */
  base: string;
}

function one (v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * The account a request addresses, from the core's headers, or null: a platform address, per-user off (no `domain`),
 * or headers not of the shape `https://<name>.<domain><basePath>` (the demo's nginx reaches the sidecar without the
 * core, so there the headers are the client's).
 */
export function addressedAccount (headers: IncomingHttpHeaders, domain: string | undefined, basePath: string): Addressed | null {
  const name = one(headers['x-adapter-name']);
  const base = one(headers['x-adapter-base']);
  if (!domain || !name || !base || !LABEL.test(name)) return null;
  let u: URL;
  try { u = new URL(base); } catch { return null; }
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash || u.pathname !== basePath) return null;
  if (u.hostname !== `${name}.${domain}`) return null;
  return { name, base: u.href };
}

/** The address template the account app fills with the person's username. */
export function perUserTemplate (domain: string, path: string): string {
  return `https://{username}.${domain}${path}`;
}
