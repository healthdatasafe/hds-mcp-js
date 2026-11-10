/** Per-call budgets: a core write of 500 events or the ~1 MB data-model pack takes longer than a service-info read. */
export const TIMEOUT_MS = { api: 60_000, pack: 30_000, info: 10_000 } as const;

/**
 * Every outbound call of the tools: a timeout, so a slow or hostile upstream cannot hang a tool call, and redirects
 * never followed (a 3xx is a non-ok answer every caller already refuses). Not 'error': undici then turns a 421 from
 * another core into a thrown "fetch failed" (B-2026-11-09-1).
 */
export async function policyFetch (url: string | URL, init: RequestInit = {}, timeoutMs: number = TIMEOUT_MS.info): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if ((err as Error)?.name === 'TimeoutError') {
      const e = new Error(`no answer within ${timeoutMs / 1000} s`);
      e.name = 'TimeoutError';
      throw e;
    }
    throw err;
  }
}

/** A core error id (`forbidden`, `unknown-resource`, …): a fixed slug, never free text. */
const ERROR_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * An upstream answered with this HTTP status: kept so a tool failure can be counted by kind (observability). `errorId`
 * is the core's `error.id` when it answered one, for report_problem's draft.
 */
export class UpstreamError extends Error {
  readonly status: number;
  readonly errorId: string | null;
  constructor (message: string, status: number, errorId?: unknown) {
    super(message);
    this.status = status;
    this.errorId = typeof errorId === 'string' && ERROR_ID_RE.test(errorId) ? errorId : null;
  }
}
