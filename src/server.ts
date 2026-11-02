import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { connectInput, connectHandler } from './tools/connect.ts';
import { listStreamsInput, listStreamsHandler } from './tools/listStreams.ts';
import { getEventsInput, getEventsHandler } from './tools/getEvents.ts';
import { createEventInput, createEventHandler } from './tools/createEvent.ts';
import { importBatchInput, importBatchHandler } from './tools/importBatch.ts';
import { searchItemsInput, searchItemsHandler } from './tools/searchItems.ts';
import { getItemInput, getItemHandler } from './tools/getItem.ts';
import { getEventTypeInput, getEventTypeHandler } from './tools/getEventType.ts';
import { listModelStreamsInput, listModelStreamsHandler } from './tools/listModelStreams.ts';
import { listDatasourcesInput, listDatasourcesHandler } from './tools/listDatasources.ts';
import { searchDatasetInput, searchDatasetHandler } from './tools/searchDataset.ts';
import { ensureStreamsInput, ensureStreamsHandler } from './tools/ensureStreams.ts';
import { updateEventInput, updateEventHandler } from './tools/updateEvent.ts';
import { deleteEventsInput, deleteEventsHandler } from './tools/deleteEvents.ts';
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
export const { name: packageName, version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);

// http: the remote transport, where the user signs in through OAuth before the first call, so there is no connect.
const PRIVACY_DISCLOSURE = 'Before reading any health record, tell the user in plain words that everything you read is sent to your model provider, that a provider that does not train on their data or a local model is the safer choice, and that they can stop at any point; repeat it before the first read of a production account (reads on production need no unlock).';

export function buildServer ({ http = false }: { http?: boolean } = {}): McpServer {
  const server = new McpServer({
    name: 'hds-mcp',
    version
  }, {
    instructions: 'Health Data Safe (HDS) account tools. ' + PRIVACY_DISCLOSURE +
      ' Always look data up in the HDS data model (search_items, get_item) before writing it.'
  });

  if (!http) {
    server.tool(
      'connect',
      'Connect to an HDS / Pryv account via OAuth. Opens your browser to sign in. Demo by default. For an import, pass roots (only the root streams it writes, from list_model_streams) and importName (its own app access, so every event names the import and it can be removed later); tell the user which kinds of data and which level the access covers before signing in. ' + PRIVACY_DISCLOSURE,
      connectInput,
      wrap(connectHandler)
    );
  }

  server.tool(
    'list_streams',
    'List the streams (data containers) in the connected HDS account. Returns the stream tree.',
    listStreamsInput,
    wrap(listStreamsHandler)
  );

  server.tool(
    'get_events',
    'Get events (data points) from the connected HDS account, optionally filtered by stream, type, time range, clientData.sourceKey prefix (everything one import wrote) or the event they cite (relatedTo). state: \'all\' includes trashed events, which a re-run must see and leave trashed. Pages with limit + skip.',
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

  // Not over HTTP: OAuth grants never carry manage, so stream creation is always refused there.
  if (!http) {
    server.tool(
      'ensure_streams',
      'Create the streams the given HDS items need in the connected account, with their data-model names, parents first (call before writing to items whose streams may not exist yet). Needs manage on the root. Refuses on production until the production-write gate is opened.',
      ensureStreamsInput,
      wrap(ensureStreamsHandler)
    );
  }

  server.tool(
    'update_event',
    'Change one event in place (content, time, description, clientData, …), e.g. when an import runs again and a record changed: find it by clientData.sourceKey with get_events. Content is checked against the event type first. clientData is replaced whole: keep sourceKey. Never update a trashed event: the user removed it. Refuses on production until the production-write gate is opened.',
    updateEventInput,
    wrap(updateEventHandler)
  );

  server.tool(
    'delete_events',
    'Delete events by id, or everything one import wrote by clientData.sourceKey prefix. Without confirm: true it is a dry run that lists what would go: show the list to the user and only confirm after they agree. Deletes citing events before their sources. A first delete moves events to the trash; deleting trashed events removes them for good. Refuses on production until the production-write gate is opened.',
    deleteEventsInput,
    wrap(deleteEventsHandler)
  );

  server.tool(
    'search_items',
    'Search the HDS data-model for items (the canonical, human-meaningful unit: a streamId + eventType + content shape). Use this BEFORE create_event or import_batch to find the right item. Searches labels in every language the model has (English, French), and terminology codes: a LOINC or SNOMED-CT code finds the item that owns it (use the item, not a generic lab result, when one does). Deprecated items are hidden unless asked for. If a search returns no match for the user\'s data, surface that to the user — do not fall back to inventing types.',
    searchItemsInput,
    wrap(searchItemsHandler)
  );

  server.tool(
    'get_item',
    'Get the full definition of a single HDS item by key (e.g. "body-weight"). Call this after search_items to read the spec before writing events. Returns the canonical streamId, eventType (or the unit choices), scale/unit/options if any, the content schema of each eventType, and the data-model version.',
    getItemInput,
    wrap(getItemHandler)
  );

  server.tool(
    'get_event_type',
    'Get one HDS event type: its content schema (what create_event / import_batch accept), the unit name for measurement types, whether it needs an attachment, and the items that use it. Reads the data model only; no account needed.',
    getEventTypeInput,
    wrap(getEventTypeHandler)
  );

  server.tool(
    'list_model_streams',
    'Browse the stream tree of the HDS data model: the root streams (the consent units apps ask access to) or the children of one stream, with the items each holds. This is the model, not the user\'s account: use list_streams for the account. No account needed.',
    listModelStreamsInput,
    wrap(listModelStreamsHandler)
  );

  server.tool(
    'list_datasources',
    'List the HDS datasets (curated, coded lists: conditions, findings, medications, procedures, treatments) and the items that take a value from each. Use search_dataset to look up an entry. No account needed.',
    listDatasourcesInput,
    wrap(listDatasourcesHandler)
  );

  server.tool(
    'search_dataset',
    'Search an HDS dataset (from list_datasources) for a coded entry, e.g. a diagnosis for condition-coded or a drug for medication-intake-coded, and get its label, codes (SNOMED-CT, ATC, RxNorm, …) and hdsId to store unchanged in the item\'s content. The search text is sent to the HDS datasets service of the connected platform (demo when not connected); tell the user when the text names their condition or medication. The lists are curated and incomplete: on no match, tell the user, never invent a code.',
    searchDatasetInput,
    wrap(searchDatasetHandler)
  );

  return server;
}
