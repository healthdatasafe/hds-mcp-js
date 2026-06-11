let currentApiEndpoint: string | null = null;
let prodWritesEnabled = false;

export function setApiEndpoint (apiEndpoint: string, enableProdWrites = false): void {
  currentApiEndpoint = apiEndpoint;
  prodWritesEnabled = enableProdWrites;
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
}

export function isConnected (): boolean {
  return currentApiEndpoint != null;
}
