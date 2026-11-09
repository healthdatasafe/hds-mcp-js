import os from 'node:os';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { safeLog } from '../lib/scrubber.ts';
import { adapterBasePath } from './paths.ts';

// hds-observability-js is an optional dependency: a stdio install may skip it, and the `prepare` build must still
// compile. So nothing here imports it statically, types included: the slice used is declared below and the module is
// loaded at runtime by initHttpObservability.
// Mirrors hds-observability-js dist/types.d.ts (STATUS_CLASSES, Exporter).
type StatusClass = '2xx' | '3xx' | '4xx' | '5xx' | 'ok' | 'error';
type Exporter = (window: unknown, service: unknown) => Promise<void>;
interface Observability<M extends string, E extends string> {
  recordCall (method: M, status: StatusClass, durationMs: number): void;
  recordError (code: E): void;
  stop (): Promise<void>;
}
interface ObservabilityLib {
  createObservability (opts: {
    service: { name: string; version: string; instance: string };
    methods: readonly string[];
    errorCodes: readonly string[];
    exporter: Exporter;
    onRefused?: (reason: string, value: string) => void;
  }): Observability<string, ErrorCode>;
  otlpExporter (opts: { endpoint: string }): Exporter;
}
const OBSERVABILITY_MODULE = 'hds-observability-js';

/**
 * Aggregate, allow-list telemetry for the HTTP transport (plan 88), through `hds-observability-js` only: no vendor
 * agent runs in this process. Per route-pattern call counts and durations, plus error counts by a closed set of
 * codes derived from the HTTP status. A request is recorded only when its method and path equal one of the
 * registered constants below, so no concrete path or other runtime string can reach the wire.
 *
 * Disabled unless `HDS_OTEL_ENDPOINT` is set (same variables as lib-bridge-js); the stdio server never loads this.
 */

export const ERROR_CODES = [
  'UNAUTHORIZED', 'FORBIDDEN', 'BAD_REQUEST', 'NOT_FOUND',
  'CONFLICT', 'RATE_LIMITED', 'UPSTREAM_ERROR', 'INTERNAL_ERROR', 'TOOL_ERROR'
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type HttpObservability = Pick<Observability<string, ErrorCode>, 'recordCall' | 'recordError'>;

/** The closed set of `METHOD /path` ids this app serves, from its MCP path (deployment config, never request data). */
export function httpMethods (mcpPath: string): string[] {
  const rs = mcpPath === '/' ? '' : mcpPath;
  const base = adapterBasePath(mcpPath);
  return [...new Set([
    `POST ${mcpPath}`, `GET ${mcpPath}`, `DELETE ${mcpPath}`,
    'GET /status',
    `GET ${base}status`,
    `GET ${base}manifest.json`,
    `POST ${base}raw`, `GET ${base}raw`, `DELETE ${base}raw`,
    `GET /.well-known/oauth-protected-resource${rs}`,
    'GET /.well-known/oauth-authorization-server'
  ])];
}

function statusClassOf (code: number): StatusClass {
  const c = Math.floor(code / 100);
  return (c >= 2 && c <= 5) ? (`${c}xx` as StatusClass) : 'error';
}

/** Same mapping as lib-bridge-js 0.16.1: a rate limit is not an upstream failure, a gateway error not our bug. */
export function errorCodeOf (code: number): ErrorCode {
  switch (code) {
    case 401: return 'UNAUTHORIZED';
    case 403: return 'FORBIDDEN';
    case 400: return 'BAD_REQUEST';
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    case 429: return 'RATE_LIMITED';
    case 502: case 503: case 504: return 'UPSTREAM_ERROR';
    default: return code >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST';
  }
}

/**
 * A failed tool call, by kind. The status is the upstream's (core, datasets, pack), so any 5xx there is
 * UPSTREAM_ERROR; no answer (timeout, network) too. Anything else the tool refused itself is TOOL_ERROR.
 */
export function toolErrorCodeOf (err: unknown): ErrorCode {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number') return status >= 500 ? 'UPSTREAM_ERROR' : errorCodeOf(status);
  const name = (err as Error)?.name;
  if (name === 'TimeoutError' || (err instanceof TypeError && err.message === 'fetch failed')) return 'UPSTREAM_ERROR';
  return 'TOOL_ERROR';
}

/** The `tool <name>` ids of the MCP tools, recorded with status class `error` (closed set, from the code). */
export function toolMethods (toolNames: readonly string[]): string[] {
  return toolNames.map((n) => `tool ${n}`);
}

/**
 * Records each failed tool call: `tool <name>` / `error` in hds.calls (which tool) and its code in hds.errors (why).
 * Successes are not recorded: the POST that carried them already is, and counting them again would dilute the
 * service's 5xx rate condition (a percentage of all hds.calls). Installed by httpMain when telemetry is on.
 */
export function toolObserver (obs: HttpObservability) {
  return (tool: string, err: unknown | null, durationMs: number) => {
    if (err == null) return;
    try {
      obs.recordCall(`tool ${tool}`, 'error', durationMs);
      obs.recordError(toolErrorCodeOf(err));
    } catch { /* telemetry must never break a tool call */ }
  };
}

/** Timing middleware: install first. Records on `finish`, only for a registered id; never breaks a response. */
export function observabilityTiming (obs: HttpObservability, methods: readonly string[]): RequestHandler {
  const known = new Set(methods);
  return (req: Request, res: Response, next: NextFunction) => {
    const start = performance.now();
    res.on('finish', () => {
      try {
        const id = `${req.method} ${(req.originalUrl ?? '').split('?')[0]}`;
        if (!known.has(id)) return;
        obs.recordCall(id, statusClassOf(res.statusCode), performance.now() - start);
        if (res.statusCode >= 400) obs.recordError(errorCodeOf(res.statusCode));
      } catch { /* telemetry must never break a response */ }
    });
    next();
  };
}

function metricsUrl (base: string): string {
  return base.endsWith('/v1/metrics') ? base : base.replace(/\/+$/, '') + '/v1/metrics';
}

function sanitize (v: string): string {
  const s = v.replace(/[^A-Za-z0-9._:-]/g, '-').replace(/^[^A-Za-z0-9]/, 'x').slice(0, 64);
  return s.length > 0 ? s : 'unknown';
}

/**
 * Build the emitter from the environment, or null when `HDS_OTEL_ENDPOINT` is unset or the optional
 * `hds-observability-js` is not installed (a local stdio install may skip it; the image always has it).
 * `HDS_OTEL_SERVICE_NAME` defaults to `hds-<HDS_ENV|dev>-mcp`.
 */
export async function initHttpObservability (
  env: NodeJS.ProcessEnv,
  version: string,
  methods: readonly string[],
  exporter?: Exporter
): Promise<Observability<string, ErrorCode> | null> {
  const endpoint = env.HDS_OTEL_ENDPOINT;
  if (!endpoint) {
    safeLog('observability disabled: no HDS_OTEL_ENDPOINT configured');
    return null;
  }
  let lib: ObservabilityLib;
  try {
    lib = await import(OBSERVABILITY_MODULE) as ObservabilityLib;
  } catch (err) {
    safeLog(`observability disabled: hds-observability-js is not installed (${(err as Error).message})`);
    return null;
  }
  const serviceName = sanitize(env.HDS_OTEL_SERVICE_NAME || `hds-${env.HDS_ENV || 'dev'}-mcp`);
  const obs = lib.createObservability({
    service: { name: serviceName, version: sanitize(version), instance: sanitize(os.hostname() || String(process.pid)) },
    methods,
    errorCodes: ERROR_CODES,
    exporter: exporter ?? lib.otlpExporter({ endpoint: metricsUrl(endpoint) }),
    onRefused: (reason, value) => safeLog(`observability drop [${reason}]: ${value}`)
  });
  safeLog(`observability enabled: service=${serviceName} endpoint=${metricsUrl(endpoint)} methods=${methods.length}`);
  return obs;
}
