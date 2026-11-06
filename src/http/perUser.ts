/**
 * Per-user addresses (plan 118 PER-USER-ADDRESS.md, open-pryv.io R10): the MCP is also reached as
 * `https://<username>.<domain><path>`, the person's own API host, so nobody has to know their region. The core keeps
 * the client's Host when it forwards to the sidecar (R8). The resource, its RFC 9728 metadata and the challenges then
 * name that host; which username may fill it is the core's to enforce (R10: only the signed-in account), at sign-in
 * and at the token exchange.
 */

// One DNS label: the API host's username part.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The per-user host the request came in on, lower-cased, or null (not under `domain`, a port, several labels). */
export function perUserHost (host: string | undefined, domain: string | undefined): string | null {
  if (!host || !domain) return null;
  const h = host.toLowerCase();
  const suffix = `.${domain.toLowerCase()}`;
  if (!h.endsWith(suffix)) return null;
  return LABEL.test(h.slice(0, -suffix.length)) ? h : null;
}

/** The address template the account app fills with the person's username. */
export function perUserTemplate (domain: string, path: string): string {
  return `https://{username}.${domain}${path}`;
}
