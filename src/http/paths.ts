/**
 * The adapter base path: the MCP path's folder (`/mcp` → `/`, `/adapter/mcp/mcp` → `/adapter/mcp/`). As a sidecar
 * the core forwards only `<base>` and the root RFC 9728 path to this server (adapter contract §5), so the manifest
 * and status live under it.
 */
export function adapterBasePath (mcpPath: string): string {
  return mcpPath.slice(0, mcpPath.lastIndexOf('/') + 1);
}
