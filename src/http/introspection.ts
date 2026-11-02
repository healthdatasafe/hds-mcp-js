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
  cacheMs?: number;
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
        body: new URLSearchParams({ token }).toString()
      });
      if (!res.ok) {
        safeLog(`introspection failed: HTTP ${res.status} (is the MCP registered with --can-introspect?)`);
        throw new Error(`introspection failed: HTTP ${res.status}`);
      }
      const body = await res.json() as IntrospectionResponse;
      if (!body.active) throw new InvalidTokenError('Token is not active');
      if (!audienceMatches(body.aud, cfg.resourceUrl)) throw new InvalidTokenError('Token was not issued for this MCP server');
      if (!body.api_base) throw new InvalidTokenError('Token carries no API base');
      const api = new URL(body.api_base);
      if (isProdHost(api.href)) throw new InvalidTokenError('The remote HDS MCP is not available for production accounts yet');
      api.username = token;

      const credentials: RequestCredentials = {
        apiEndpoint: api.href,
        serviceInfoUrl: cfg.serviceInfoUrl,
        prodWritesEnabled: false
      };
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
      cache.set(token, { info, until });
      return info;
    }
  };
}
