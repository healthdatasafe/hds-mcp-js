import { AsyncLocalStorage } from 'node:async_hooks';

// stdio: one user per process, set by the connect tool.
let currentApiEndpoint: string | null = null;
let prodWritesEnabled = false;
let currentServiceInfoUrl: string | null = null;

// HTTP: one user per request. Never fall through to the stdio globals from inside a request.
export interface RequestCredentials {
  apiEndpoint: string;
  serviceInfoUrl: string;
  prodWritesEnabled: boolean;
}
const requestCredentials = new AsyncLocalStorage<RequestCredentials>();

/** Runs `fn` with these credentials for every tool call it makes (HTTP transport). */
export function runWithCredentials<T> (creds: RequestCredentials, fn: () => T): T {
  return requestCredentials.run(creds, fn);
}

export function setApiEndpoint (apiEndpoint: string, enableProdWrites = false, serviceInfoUrl?: string): void {
  if (requestCredentials.getStore()) throw new Error('connect is not available over HTTP: sign in through OAuth.');
  currentApiEndpoint = apiEndpoint;
  prodWritesEnabled = enableProdWrites;
  currentServiceInfoUrl = serviceInfoUrl ?? null;
}

/** The service-info URL of the connected platform, or null before connect. */
export function getServiceInfoUrl (): string | null {
  const req = requestCredentials.getStore();
  if (req) return req.serviceInfoUrl;
  return currentServiceInfoUrl;
}

export function getApiEndpoint (): string {
  const req = requestCredentials.getStore();
  if (req) {
    // Raw mode before sign-in: an empty endpoint, never the stdio globals.
    if (!req.apiEndpoint) throw new Error('Not connected. Call connect and have the person sign in first.');
    return req.apiEndpoint;
  }
  if (currentApiEndpoint == null) {
    throw new Error('Not connected. Run the `hds.connect` tool first.');
  }
  return currentApiEndpoint;
}

export function getProdWritesEnabled (): boolean {
  const req = requestCredentials.getStore();
  if (req) return req.prodWritesEnabled;
  return prodWritesEnabled;
}

export function clearApiEndpoint (): void {
  currentApiEndpoint = null;
  prodWritesEnabled = false;
  currentServiceInfoUrl = null;
}

export function isConnected (): boolean {
  const req = requestCredentials.getStore();
  return req ? Boolean(req.apiEndpoint) : currentApiEndpoint != null;
}
