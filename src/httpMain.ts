#!/usr/bin/env node
import type { OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createHttpApp } from './http/app.ts';
import { introspectionVerifier } from './http/introspection.ts';
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

const metaRes = await fetch(`${issuer}/.well-known/oauth-authorization-server`);
if (!metaRes.ok) throw new Error(`Cannot read the authorization server metadata of ${issuer}: HTTP ${metaRes.status}`);
const oauthMetadata = await metaRes.json() as OAuthMetadata & { introspection_endpoint?: string };
if (!oauthMetadata.introspection_endpoint) throw new Error(`${issuer} publishes no introspection endpoint`);

const app = createHttpApp({
  publicUrl,
  oauthMetadata,
  allowedOrigins: (process.env.HDS_MCP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  verifier: introspectionVerifier({
    introspectionEndpoint: oauthMetadata.introspection_endpoint,
    clientId: required('HDS_MCP_INTROSPECT_CLIENT_ID'),
    clientSecret: required('HDS_MCP_INTROSPECT_CLIENT_SECRET'),
    resourceUrl: publicUrl,
    serviceInfoUrl
  })
});
app.listen(port, () => safeLog(`hds-mcp HTTP listening on :${port}, resource ${publicUrl.href}, issuer ${issuer}`));
