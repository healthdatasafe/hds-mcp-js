let currentApiEndpoint: string | null = null;
let prodWritesEnabled = false;
let currentServiceInfoUrl: string | null = null;

export function setApiEndpoint (apiEndpoint: string, enableProdWrites = false, serviceInfoUrl?: string): void {
  currentApiEndpoint = apiEndpoint;
  prodWritesEnabled = enableProdWrites;
  currentServiceInfoUrl = serviceInfoUrl ?? null;
}

/** The service-info URL of the connected platform, or null before connect. */
export function getServiceInfoUrl (): string | null {
  return currentServiceInfoUrl;
}

export function getApiEndpoint (): string {
  if (currentApiEndpoint == null) {
    throw new Error('Not connected. Run the `hds.connect` tool first.');
  }
  return currentApiEndpoint;
}

export function getProdWritesEnabled (): boolean {
  return prodWritesEnabled;
}

export function clearApiEndpoint (): void {
  currentApiEndpoint = null;
  prodWritesEnabled = false;
  currentServiceInfoUrl = null;
}

export function isConnected (): boolean {
  return currentApiEndpoint != null;
}
