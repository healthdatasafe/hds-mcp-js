let currentApiEndpoint: string | null = null;

export function setApiEndpoint (apiEndpoint: string): void {
  currentApiEndpoint = apiEndpoint;
}

export function getApiEndpoint (): string {
  if (currentApiEndpoint == null) {
    throw new Error('Not connected. Run the `hds.connect` tool first.');
  }
  return currentApiEndpoint;
}

export function clearApiEndpoint (): void {
  currentApiEndpoint = null;
}

export function isConnected (): boolean {
  return currentApiEndpoint != null;
}
