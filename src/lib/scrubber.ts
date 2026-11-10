const URL_USERINFO_RE = /(https?:\/\/)[^@/\s]+@/gi;
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_PARAM_RE = /\b(auth|token|access_token|refresh_token|id_token|code|code_verifier|client_secret|secret|password|key)=[^\s&#"']+/gi;

/** Logs and tool errors: the credentials (URL userinfo, Bearer values, token-like query parameters). */
export function scrubTokens (value: unknown): string {
  if (value == null) return String(value);
  let s = typeof value === 'string' ? value : safeStringify(value);
  s = s.replace(URL_USERINFO_RE, '$1***@');
  s = s.replace(BEARER_RE, '$1 ***');
  s = s.replace(SECRET_PARAM_RE, '$1=***');
  return s;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const URL_QUERY_RE = /(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi;
// A per-user address on an HDS platform: `<username>.api.datasafe.dev`, `<username>.demo.datasafe.dev`.
const PER_USER_HOST_RE = /\b([a-z0-9][a-z0-9-]*)\.((?:api|demo)\.datasafe\.dev)\b/gi;
const PLATFORM_LABELS = new Set(['reg', 'access', 'mfa', 'sw', 'hfs', 'previews', 'www']);
// Opaque values: access tokens (cuid, 25 chars), JWT parts, keys, hashes. Letters and digits both, so long item keys
// and stream ids (`fertility-cycles-average-peak-day`) stay readable.
const LONG_OPAQUE_RE = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g;

// `Authorization: <anything>` (Pryv takes the raw token there, no scheme), cookies, API-key headers: the value to the
// end of the line. Over-scrubbing the rest of a sentence is the safe side.
const HEADER_SECRET_RE = /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)([ \t]*:[ \t]*)[^\r\n"]+/gi;
// The same secrets as JSON keys, as they appear in a serialized request or error object.
const JSON_SECRET_RE = /("(?:auth|token|access_?token|refresh_?token|id_?token|password|password_?hash|secret|client_?secret|api_?endpoint|authorization|cookie)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;
// An apiEndpoint (`https://<token>@<host>/<path>`): reduced to scheme + host, so a path-style username goes too.
const API_ENDPOINT_RE = /(https?:\/\/)[^@/\s"'<>]+@([A-Za-z0-9.-]+(?::\d+)?)[^\s"'<>)\]]*/gi;

/**
 * Free text bound for a report (report_problem's draft: the HDS review page or a public GitHub issue): the credentials
 * of scrubTokens, plus header and JSON secrets, any URL with userinfo reduced to scheme + host, and what identifies the
 * person: emails, per-user hostnames, query strings and fragments, long opaque values, and the connected account's
 * name when known. The tool description also asks the model to leave these out; this is the net under it.
 *
 * Without `username` the output is byte-identical to hds-issues-service `scrubIntake` (no publishUsername), the scrub
 * the intake applies again before filing: tests/scrubber.test.ts pins the same table as that service's scrub tests.
 */
export function scrubReport (value: string, { username }: { username?: string | null } = {}): string {
  let s = String(value);
  s = s.replace(JSON_SECRET_RE, '$1"***"');
  s = s.replace(HEADER_SECRET_RE, '$1$2***');
  s = s.replace(API_ENDPOINT_RE, '$1***@$2/');
  s = scrubTokens(s);
  s = s.replace(URL_QUERY_RE, '$1?…');
  s = s.replace(EMAIL_RE, '[email]');
  s = s.replace(PER_USER_HOST_RE, (m, label: string, rest: string) =>
    PLATFORM_LABELS.has(label.toLowerCase()) || /^core-/i.test(label) ? m : `{username}.${rest}`);
  s = s.replace(LONG_OPAQUE_RE, '[id]');
  if (username && username.length >= 3) {
    s = s.replace(new RegExp(`\\b${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '{username}');
  }
  return s;
}

function safeStringify (value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function safeLog (...args: unknown[]): void {
  const scrubbed = args.map((a) => scrubTokens(a));
  process.stderr.write(scrubbed.join(' ') + '\n');
}

export function scrubError (err: unknown): Error {
  if (err instanceof Error) {
    const next = new Error(scrubTokens(err.message));
    next.stack = err.stack ? scrubTokens(err.stack) : undefined;
    next.name = err.name;
    return next;
  }
  return new Error(scrubTokens(err));
}
