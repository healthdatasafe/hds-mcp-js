import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { connectInput, connectHandler } from './tools/connect.ts';
import { listStreamsInput, listStreamsHandler } from './tools/listStreams.ts';
import { getEventsInput, getEventsHandler } from './tools/getEvents.ts';
import { createEventInput, createEventHandler } from './tools/createEvent.ts';
import { importBatchInput, importBatchHandler } from './tools/importBatch.ts';
import { searchItemsInput, searchItemsHandler } from './tools/searchItems.ts';
import { getItemInput, getItemHandler } from './tools/getItem.ts';
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
    version: '0.0.4'
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

  server.tool(
    'create_event',
    'Create a single event (data point) in the connected HDS account. Always call search_items first to find the canonical HDS item for the data type, then get_item to read its spec, and use that streamId + eventType. If no item matches, ask the user before inventing a type. Refuses on production until the production-write gate is opened.',
    createEventInput,
    wrap(createEventHandler)
  );

  server.tool(
    'import_batch',
    'Import many events at once (1–500 per call). Always call search_items first to find the canonical HDS item for each data type, then get_item for its spec, and use those streamId + eventType values. If no item matches for some data, ask the user before inventing a type. Refuses on production until the production-write gate is opened.',
    importBatchInput,
    wrap(importBatchHandler)
  );

  server.tool(
    'search_items',
    'Search the HDS data-model for items (the canonical, human-meaningful unit: a streamId + eventType + content shape). Use this BEFORE create_event or import_batch to find the right item. If a search returns no match for the user\'s data, surface that to the user — do not fall back to inventing types.',
    searchItemsInput,
    wrap(searchItemsHandler)
  );

  server.tool(
    'get_item',
    'Get the full definition of a single HDS item by key (e.g. "body-weight"). Call this after search_items to read the spec before writing events. Returns the canonical streamId, eventType, content shape, scale/unit/options if any.',
    getItemInput,
    wrap(getItemHandler)
  );

  return server;
}
