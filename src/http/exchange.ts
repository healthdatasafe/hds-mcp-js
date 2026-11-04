import { InvalidTokenError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { safeLog } from '../lib/scrubber.ts';
import { apiCredentials } from './introspection.ts';

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

export interface ExchangeConfig {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  // This MCP's public URL, reported as the token's resource.
  resourceUrl: URL;
  serviceInfoUrl: string;
  cacheMs?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

interface ExchangeResponse {
  access_token?: string;
  issued_token_type?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  api_base?: string;
  error?: string;
  error_description?: string;
}

/**
 * Validates bearer tokens by exchanging them at the core (RFC 8693, plan 118 item 6, PY1 design R7): the core checks
 * the connector's token and its audience, and returns a derived token of the same grant that the API accepts. The
 * tools call the API with the derived token; the connector's token never reaches the data API.
 */
export function exchangeVerifier (cfg: ExchangeConfig): OAuthTokenVerifier {
  const cache = new Map<string, { info: AuthInfo; until: number }>();
  const cacheMs = cfg.cacheMs ?? 60_000;
  const doFetch = cfg.fetchFn ?? fetch;
  const basic = 'Basic ' + Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString('base64');

  return {
    async verifyAccessToken (token: string): Promise<AuthInfo> {
      const now = Date.now();
      const hit = cache.get(token);
      if (hit && hit.until > now) return hit.info;

      const res = await doFetch(cfg.tokenEndpoint, {
        method: 'POST',
        headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: TOKEN_EXCHANGE, subject_token: token, subject_token_type: ACCESS_TOKEN_TYPE }).toString(),
        // A redirect would re-post the subject token off the issuer's host.
        redirect: 'error',
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 10_000)
      });
      const body = await res.json().catch(() => ({})) as ExchangeResponse & { coreUrl?: string };
      if (!res.ok) {
        // The user's token is dead or not for this MCP: the client refreshes or signs in again.
        if (body.error === 'invalid_grant' || body.error === 'invalid_target') throw new InvalidTokenError('Token is not active for this MCP server');
        // Anything else is ours to fix (row not flagged --can-exchange, suspended, 421 from a second core).
        const hint = body.error === 'unauthorized_client' ? ' (is the MCP registered with --can-exchange?)' : '';
        safeLog(`token exchange failed: HTTP ${res.status} ${body.error ?? ''} ${body.error_description ?? ''}${body.coreUrl ? ` coreUrl ${body.coreUrl}` : ''}${hint}`);
        throw new ServerError('token exchange failed');
      }
      const ttl = body.expires_in;
      if (!body.access_token || body.token_type?.toLowerCase() !== 'bearer' || body.issued_token_type !== ACCESS_TOKEN_TYPE ||
          !Number.isInteger(ttl) || (ttl as number) <= 0 || !body.api_base?.startsWith('https://')) {
        safeLog('token exchange answered without a usable Bearer access token, expiry or https api_base');
        throw new ServerError('token exchange failed');
      }

      const credentials = apiCredentials(body.api_base, body.access_token, cfg.serviceInfoUrl);
      const expiresAt = Math.floor(now / 1000) + (ttl as number);
      const info: AuthInfo = {
        token,
        // The exchange answer names no client; the core's audit records both.
        clientId: 'connector',
        scopes: body.scope ? body.scope.split(' ') : [],
        expiresAt,
        resource: cfg.resourceUrl,
        extra: { credentials }
      };
      for (const [k, v] of cache) if (v.until <= now) cache.delete(k);
      cache.set(token, { info, until: Math.min(now + cacheMs, expiresAt * 1000) });
      return info;
    }
  };
}
