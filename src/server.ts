import { readFileSync } from 'node:fs';
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

// One level below the package root in both layouts (src/ and dist/).
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);

export function buildServer (): McpServer {
  const server = new McpServer({
    name: 'hds-mcp',
    version
  });

  server.tool(
    'connect',
    'Connect to an HDS / Pryv account via OAuth. Opens your browser to sign in. Demo by default. Before reading any health record, tell the user in plain words that everything you read is sent to your model provider, that a provider that does not train on their data or a local model is the safer choice, and that they can stop at any point; repeat it before the first read of a production account (reads on production need no unlock).',
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
    'Create a single event (data point) in the connected HDS account. Always call search_items first to find the canonical HDS item for the data type, then get_item to read its spec, and use that streamId + eventType. If no item matches, ask the user before inventing a type. The content is checked against the eventType content schema before writing; an unknown type or invalid content is refused and nothing is written. Optional description (human text every app shows) and clientData (data-model conventions such as sourceKey). Refuses on production until the production-write gate is opened.',
    createEventInput,
    wrap(createEventHandler)
  );

  server.tool(
    'import_batch',
    'Import many events at once (1–500 per call). Always call search_items first to find the canonical HDS item for each data type, then get_item for its spec, and use those streamId + eventType values. If no item matches for some data, ask the user before inventing a type. Every event is checked against its eventType content schema first; if any fails, the whole batch is refused and nothing is written. Returns the created event ids in input order, so later events can reference earlier ones. Refuses on production until the production-write gate is opened.',
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
    'Get the full definition of a single HDS item by key (e.g. "body-weight"). Call this after search_items to read the spec before writing events. Returns the canonical streamId, eventType (or the unit choices), scale/unit/options if any, the content schema of each eventType, and the data-model version.',
    getItemInput,
    wrap(getItemHandler)
  );

  return server;
}
