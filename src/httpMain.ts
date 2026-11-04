#!/usr/bin/env node
import type { OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createHttpApp } from './http/app.ts';
import { introspectionVerifier } from './http/introspection.ts';
import { httpMethods, initHttpObservability } from './http/observability.ts';
import { version } from './server.ts';
import { resolveServiceInfoUrl } from './lib/hostPolicy.ts';
import { safeLog } from './lib/scrubber.ts';

function required (name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

const issuer = required('HDS_MCP_ISSUER').replace(/\/$/, '');
const publicUrl = new URL(required('HDS_MCP_PUBLIC_URL'));
const serviceInfoUrl = resolveServiceInfoUrl(process.env.HDS_MCP_SERVICE_INFO ?? 'demo');
const port = Number(process.env.PORT ?? 3000);

const metaRes = await fetch(`${issuer}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(10_000) });
if (!metaRes.ok) throw new Error(`Cannot read the authorization server metadata of ${issuer}: HTTP ${metaRes.status}`);
const oauthMetadata = await metaRes.json() as OAuthMetadata & { introspection_endpoint?: string };
if (!oauthMetadata.introspection_endpoint) throw new Error(`${issuer} publishes no introspection endpoint`);
// The MCP posts its client secret there: https, on the issuer's own host only.
const introspectUrl = new URL(oauthMetadata.introspection_endpoint);
if (introspectUrl.protocol !== 'https:' || introspectUrl.host !== new URL(issuer).host) {
  throw new Error(`${issuer} publishes an introspection endpoint off its own https host: ${introspectUrl.href}`);
}

const methods = httpMethods(publicUrl.pathname);
const obs = await initHttpObservability(process.env, String(version), methods);

const app = createHttpApp({
  publicUrl,
  oauthMetadata,
  observability: obs ? { obs, methods } : null,
  // e.g. "claude=hds-mcp-claude,chatgpt=hds-mcp-chatgpt,claude-code=hds-mcp-claude-code"
  connectorClients: Object.fromEntries((process.env.HDS_MCP_CONNECTOR_CLIENTS ?? '').split(',')
    .map((p) => p.split('=').map((s) => s.trim())).filter((kv) => kv.length === 2 && kv[0] && kv[1])),
  allowedOrigins: (process.env.HDS_MCP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  // Space-separated, e.g. "offline_access hds/stream/body.read". Claude Code sends no scope and asks for these.
  scopesSupported: (process.env.HDS_MCP_SCOPES ?? '').split(/\s+/).filter(Boolean),
  verifier: introspectionVerifier({
    introspectionEndpoint: oauthMetadata.introspection_endpoint,
    clientId: required('HDS_MCP_INTROSPECT_CLIENT_ID'),
    clientSecret: required('HDS_MCP_INTROSPECT_CLIENT_SECRET'),
    resourceUrl: publicUrl,
    serviceInfoUrl,
    // On by default (plan 115 review S-3); `false` only for a core older than rc.70 or rows without --audience.
    requireAudience: process.env.HDS_MCP_REQUIRE_AUDIENCE !== 'false'
  })
});
const server = app.listen(port, () => safeLog(`hds-mcp HTTP listening on :${port}, resource ${publicUrl.href}, issuer ${issuer}`));

// Flush the last telemetry window on a Dokku stop / redeploy.
process.once('SIGTERM', () => {
  server.close();
  (obs ? obs.stop() : Promise.resolve()).finally(() => process.exit(0));
});
