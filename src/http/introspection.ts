import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { isProdHost } from '../lib/hostPolicy.ts';
import { safeLog } from '../lib/scrubber.ts';
import type { RequestCredentials } from '../auth/session.ts';

export interface IntrospectionConfig {
  introspectionEndpoint: string;
  clientId: string;
  clientSecret: string;
  // This MCP's public URL: a token whose `aud` names another resource is refused.
  resourceUrl: URL;
  serviceInfoUrl: string;
  // Refuse a token that carries no `aud` (default; plan 115 review S-3).
  requireAudience?: boolean;
  cacheMs?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

interface IntrospectionResponse {
  active: boolean;
  client_id?: string;
  scope?: string;
  exp?: number;
  aud?: string | string[];
  api_base?: string;
}

/** The credentials the tools use: `token` at the `api_base` the core returned (https, never a production host). */
export function apiCredentials (apiBase: string, token: string, serviceInfoUrl: string): RequestCredentials {
  const api = new URL(apiBase);
  if (api.protocol !== 'https:') throw new InvalidTokenError('Token carries a non-https API base');
  if (isProdHost(api.href)) throw new InvalidTokenError('The remote HDS MCP is not available for production accounts yet');
  api.username = token;
  return { apiEndpoint: api.href, serviceInfoUrl, prodWritesEnabled: false };
}

function audienceMatches (aud: string | string[] | undefined, resource: URL): boolean {
  if (aud == null) return true;
  const want = resource.href.replace(/#.*$/, '').replace(/\/$/, '');
  return (Array.isArray(aud) ? aud : [aud]).some((a) => a.replace(/\/$/, '') === want);
}

/**
 * Validates bearer tokens through the core's RFC 7662 introspection and builds the credentials the tools use.
 * Spike decision (plan 118, perki 2026-11-02): the API is called with the same token, at the `api_base` the core
 * returns. A separate credential through token exchange is required before production.
 */
export function introspectionVerifier (cfg: IntrospectionConfig): OAuthTokenVerifier {
  const cache = new Map<string, { info: AuthInfo; until: number }>();
  const cacheMs = cfg.cacheMs ?? 60_000;
  const requireAudience = cfg.requireAudience ?? true;
  const doFetch = cfg.fetchFn ?? fetch;
  const basic = 'Basic ' + Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString('base64');

  return {
    async verifyAccessToken (token: string): Promise<AuthInfo> {
      const now = Date.now();
      const hit = cache.get(token);
      if (hit && hit.until > now) return hit.info;

      const res = await doFetch(cfg.introspectionEndpoint, {
        method: 'POST',
        headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
        // A redirect would re-post the token off the issuer's host.
        redirect: 'error',
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 10_000)
      });
      if (!res.ok) {
        safeLog(`introspection failed: HTTP ${res.status} (is the MCP registered with --can-introspect?)`);
        throw new Error(`introspection failed: HTTP ${res.status}`);
      }
      const body = await res.json() as IntrospectionResponse;
      if (!body.active) throw new InvalidTokenError('Token is not active');
      if (requireAudience && body.aud == null) throw new InvalidTokenError('Token was not issued for this MCP server');
      if (!audienceMatches(body.aud, cfg.resourceUrl)) throw new InvalidTokenError('Token was not issued for this MCP server');
      if (!body.api_base) throw new InvalidTokenError('Token carries no API base');
      const credentials = apiCredentials(body.api_base, token, cfg.serviceInfoUrl);
      const info: AuthInfo = {
        token,
        clientId: body.client_id ?? 'unknown',
        scopes: body.scope ? body.scope.split(' ') : [],
        // The SDK refuses a token without expiry; without `exp`, trust it no longer than the cache window.
        expiresAt: body.exp ?? Math.floor((now + cacheMs) / 1000),
        resource: cfg.resourceUrl,
        extra: { credentials }
      };
      const until = Math.min(now + cacheMs, body.exp ? body.exp * 1000 : Infinity);
      for (const [k, v] of cache) if (v.until <= now) cache.delete(k);
      cache.set(token, { info, until });
      return info;
    }
  };
}
