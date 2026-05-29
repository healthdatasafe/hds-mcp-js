#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.ts';
import { safeLog } from './lib/scrubber.ts';

async function main (): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  safeLog('hds-mcp ready (stdio)');
}

main().catch((err) => {
  process.stderr.write(`hds-mcp fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
