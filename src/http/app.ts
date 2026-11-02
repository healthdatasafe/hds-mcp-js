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

export interface HttpAppConfig {
  publicUrl: URL;
  oauthMetadata: OAuthMetadata;
  verifier: OAuthTokenVerifier;
  allowedOrigins: string[];
  /** Aggregate telemetry (hds-observability-js); omitted or null when disabled. */
  observability?: { obs: HttpObservability, methods: readonly string[] } | null;
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
  // Liveness for the Dokku deploy healthcheck and deploy-image.sh (which reads `version`). No auth, no dependency.
  app.get('/status', (_req: Request, res: Response) => {
    res.json({ status: 'ok', name: packageName, version });
  });
  app.use(originCheck(cfg.allowedOrigins));
  app.use(mcpAuthMetadataRouter({
    oauthMetadata: cfg.oauthMetadata,
    resourceServerUrl: cfg.publicUrl,
    resourceName: 'Health Data Safe'
  }));
  const auth = requireBearerAuth({
    verifier: cfg.verifier,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(cfg.publicUrl)
  });
  const path = cfg.publicUrl.pathname;

  app.post(path, express.json({ limit: '4mb' }), auth, async (req: Request, res: Response) => {
    const credentials = req.auth?.extra?.credentials as RequestCredentials | undefined;
    if (!credentials) {
      res.status(401).json({ error: 'no credentials' });
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
