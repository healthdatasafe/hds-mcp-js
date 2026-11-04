import express, { type Request, type Response, type NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { buildServer, packageName, version } from '../server.ts';
import { runWithCredentials, type RequestCredentials } from '../auth/session.ts';
import { safeLog } from '../lib/scrubber.ts';
import { observabilityTiming, type HttpObservability } from './observability.ts';
import { adapterBasePath } from './paths.ts';
import { isWriteCall, missingWriteScopes } from './stepUp.ts';
import { loadPack } from '../dataModel/pack.ts';

export interface HttpAppConfig {
  publicUrl: URL;
  oauthMetadata: OAuthMetadata;
  verifier: OAuthTokenVerifier;
  allowedOrigins: string[];
  /** Aggregate telemetry (hds-observability-js); omitted or null when disabled. */
  observability?: { obs: HttpObservability, methods: readonly string[] } | null;
  /** Public OAuth client ids registered at the core for each connector product, shown in the manifest. */
  connectorClients?: Record<string, string>;
  /** `scopes_supported` in the protected-resource metadata: what a client that names no scope asks for (MCP spec). */
  scopesSupported?: string[];
  /** Raw mode (sign in by link, no OAuth), mounted at `<base>raw`; omitted or null when disabled. */
  raw?: { mount (app: express.Express, path: string): void } | null;
}

/**
 * Pryv adapter manifest (adapter contract §3): the core lists this server's base URL in /service/info `adapters`,
 * and clients (e.g. the account app's "use HDS with your AI assistant" page) read the details here.
 */
export function adapterManifest (cfg: Pick<HttpAppConfig, 'publicUrl' | 'oauthMetadata' | 'connectorClients'>) {
  return {
    name: packageName,
    type: 'mcp',
    version,
    title: 'Health Data Safe for AI assistants',
    description: 'Model Context Protocol server: lets an AI assistant read (and, where granted, add to) a Health Data Safe account, after the person signs in and consents on HDS.',
    useCases: ['read-health-data', 'search-data-model', 'search-datasets', 'write-health-data'],
    auth: ['oauth2'],
    standards: ['MCP', 'RFC8414', 'RFC9728', 'RFC7636'],
    mcpEndpoint: cfg.publicUrl.href,
    protectedResourceMetadata: getOAuthProtectedResourceMetadataUrl(cfg.publicUrl),
    authorizationServer: cfg.oauthMetadata.issuer,
    clients: cfg.connectorClients ?? {}
  };
}

/** DNS-rebinding guard (MCP spec): a request carrying an Origin must come from an allowed one. */
function originCheck (allowed: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && !allowed.includes(origin)) {
      res.status(403).json({ error: 'origin not allowed' });
      return;
    }
    next();
  };
}

export function createHttpApp (cfg: HttpAppConfig): express.Express {
  const app = express();
  app.disable('x-powered-by');
  if (cfg.observability) app.use(observabilityTiming(cfg.observability.obs, cfg.observability.methods));
  const path = cfg.publicUrl.pathname;
  const base = adapterBasePath(path);
  // Liveness for the Dokku deploy healthcheck and deploy-image.sh (which reads `version`). No auth, no dependency.
  // At the root for the local healthcheck, and under the base where a sidecar is reachable.
  app.get([...new Set(['/status', `${base}status`])], (_req: Request, res: Response) => {
    res.json({ status: 'ok', name: packageName, version });
  });
  // Public, no credentials: readable from any origin (the account app fetches it cross-origin).
  const manifest = adapterManifest(cfg);
  app.get(`${base}manifest.json`, (_req: Request, res: Response) => {
    res.set('Access-Control-Allow-Origin', '*').json(manifest);
  });
  app.use(originCheck(cfg.allowedOrigins));
  cfg.raw?.mount(app, `${base}raw`);
  app.use(mcpAuthMetadataRouter({
    oauthMetadata: cfg.oauthMetadata,
    resourceServerUrl: cfg.publicUrl,
    resourceName: 'Health Data Safe',
    scopesSupported: cfg.scopesSupported?.length ? cfg.scopesSupported : undefined
  }));
  const auth = requireBearerAuth({
    verifier: cfg.verifier,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(cfg.publicUrl)
  });

  app.post(path, express.json({ limit: '4mb' }), auth, async (req: Request, res: Response) => {
    const credentials = req.auth?.extra?.credentials as RequestCredentials | undefined;
    if (!credentials) {
      res.status(401).json({ error: 'no credentials' });
      return;
    }
    // JSON-RPC batches left MCP in 2025-06-18; refusing them keeps every call visible to the step-up check.
    if (Array.isArray(req.body)) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Batch requests are not supported' }, id: null });
      return;
    }
    // Step-up (MCP authorization, scope challenge): a write needs write consent on its data root; the client
    // re-runs consent for the scopes named here (current ones kept, so reads are not lost).
    const missing = isWriteCall(req.body) ? missingWriteScopes(req.body, req.auth?.scopes ?? [], await loadPack()) : [];
    if (missing.length > 0) {
      const scope = [...new Set([...(req.auth?.scopes ?? []), ...missing])].join(' ');
      res.status(403).set('WWW-Authenticate',
        `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${getOAuthProtectedResourceMetadataUrl(cfg.publicUrl)}", ` +
        `error_description="Writing needs your consent to add data to: ${missing.join(', ')}"`)
        .json({ error: 'insufficient_scope', scope });
      return;
    }
    // Stateless: a new server and transport per request, the user's credentials scoped to it.
    const server = buildServer({ http: true });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await runWithCredentials(credentials, () => transport.handleRequest(req, res, req.body));
    } catch (err) {
      safeLog(`MCP request failed: ${(err as Error).message}`);
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    }
  });
  app.get(path, (_req: Request, res: Response) => { res.status(405).set('Allow', 'POST').end(); });
  app.delete(path, (_req: Request, res: Response) => { res.status(405).set('Allow', 'POST').end(); });
  return app;
}
