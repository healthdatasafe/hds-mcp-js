export const SERVICE_INFO = {
  demo: 'https://demo.datasafe.dev/reg/service/info',
  prod: 'https://reg.api.datasafe.dev/service/info'
} as const;

export type HostAlias = keyof typeof SERVICE_INFO;

export function resolveServiceInfoUrl (host?: string): string {
  if (host == null || host === '') return SERVICE_INFO.demo;
  if (host === 'demo' || host === 'prod') return SERVICE_INFO[host];
  if (host.startsWith('http://') || host.startsWith('https://')) return host;
  throw new Error(`Unrecognised host: ${host}. Use 'demo', 'prod', or a full service-info URL.`);
}

export function isProdHost (apiEndpoint: string): boolean {
  try {
    const host = new URL(apiEndpoint).hostname;
    return host.endsWith('.api.datasafe.dev');
  } catch {
    return false;
  }
}

export type Platform = 'production' | 'demo';

/** Which HDS platform an API endpoint or service-info URL belongs to. */
export function platformOf (url: string): Platform {
  return isProdHost(url) ? 'production' : 'demo';
}

export const DEMO_SIGNUP_URL = 'https://demo-account.datasafe.dev/register';

/** What the person must know about the platform, in words the model can repeat. */
export function platformNote (platform: Platform): string {
  return platform === 'production'
    ? 'This is the HDS production platform: the person\'s real health record. Before a large import, suggest trying ' +
      'it first on the demo platform with a throwaway account.'
    : 'This is the HDS demo platform: a test platform, not a real health record, which can be wiped. It is the place ' +
      `to try things out: the person can create a throwaway account with made-up details at ${DEMO_SIGNUP_URL}. ` +
      'Real records belong on the production platform.';
}

export const PROD_WRITES_ENABLED = process.env.HDS_MCP_PROD_WRITES_ENABLED === 'true';

export function assertWriteAllowed (apiEndpoint: string, sessionProdWritesEnabled = false): void {
  if (isProdHost(apiEndpoint) && !sessionProdWritesEnabled && !PROD_WRITES_ENABLED) {
    throw new Error(
      'Writes to the production HDS host are disabled for this session. ' +
      'If the user explicitly asked to write to their production account, re-run connect ' +
      "with { host: 'prod', enableWrites: true } — they confirm on the sign-in consent screen. " +
      'Otherwise stay on demo (the default).'
    );
  }
}
