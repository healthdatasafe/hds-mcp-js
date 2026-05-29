import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { connectInput, connectHandler } from './tools/connect.ts';
import { listStreamsInput, listStreamsHandler } from './tools/listStreams.ts';
import { getEventsInput, getEventsHandler } from './tools/getEvents.ts';
import { scrubError } from './lib/scrubber.ts';

function wrap<T> (handler: (a: T) => Promise<any>) {
  return async (args: T) => {
    try {
      return await handler(args);
    } catch (err) {
      const safe = scrubError(err);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: safe.message }]
      };
    }
  };
}

export function buildServer (): McpServer {
  const server = new McpServer({
    name: 'hds-mcp',
    version: '0.0.1'
  });

  server.tool(
    'connect',
    'Connect to an HDS / Pryv account via OAuth. Opens your browser to sign in. Demo by default.',
    connectInput,
    wrap(connectHandler)
  );

  server.tool(
    'list_streams',
    'List the streams (data containers) in the connected HDS account. Returns the stream tree.',
    listStreamsInput,
    wrap(listStreamsHandler)
  );

  server.tool(
    'get_events',
    'Get events (data points) from the connected HDS account, optionally filtered by stream, type, or time range.',
    getEventsInput,
    wrap(getEventsHandler)
  );

  return server;
}
