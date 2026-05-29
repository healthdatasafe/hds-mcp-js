const URL_USERINFO_RE = /(https?:\/\/)[^@/\s]+@/gi;

export function scrubTokens (value: unknown): string {
  if (value == null) return String(value);
  let s = typeof value === 'string' ? value : safeStringify(value);
  s = s.replace(URL_USERINFO_RE, '$1***@');
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
