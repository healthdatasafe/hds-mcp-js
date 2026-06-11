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
