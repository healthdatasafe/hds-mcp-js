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
import { reportMissingItemInput, reportMissingItemHandler } from './tools/reportMissingItem.ts';
import { getImportGuideInput, getImportGuideHandler } from './tools/getImportGuide.ts';
import { getConnectionInput, getConnectionHandler } from './tools/getConnection.ts';
import { reportProblemInput, reportProblemHandler, type LastFailure } from './tools/reportProblem.ts';
import { openAccountInput, openAccountHandler } from './tools/openAccount.ts';
import { extendWriteHint } from './http/stepUp.ts';
import { platformNote, type Platform } from './lib/hostPolicy.ts';
import { scrubError } from './lib/scrubber.ts';
import { UpstreamError } from './lib/fetchPolicy.ts';

/** Every tool buildServer can register: the closed set of `tool <name>` telemetry ids. */
export const TOOL_NAMES = [
  'connect', 'list_streams', 'get_events', 'create_event', 'import_batch', 'ensure_streams', 'update_event',
  'delete_events', 'search_items', 'get_item', 'get_event_type', 'list_model_streams', 'list_datasources',
  'search_dataset', 'get_connection', 'get_import_guide', 'report_missing_item', 'report_problem', 'open_account'
] as const;
type ToolName = (typeof TOOL_NAMES)[number];

type ToolObserver = (tool: ToolName, err: unknown | null, durationMs: number) => void;
let toolObserver: ToolObserver | null = null;
/** HTTP telemetry: called once per tool call, err null on success. A tool error is a 200 + isError, invisible per route. */
export function setToolObserver (fn: ToolObserver | null): void { toolObserver = fn; }

function wrapTool<T> (name: ToolName, handler: (a: T) => Promise<any>, onFailure: (f: LastFailure) => void) {
  return async (args: T) => {
    const start = performance.now();
    try {
      const result = await handler(args);
      toolObserver?.(name, null, performance.now() - start);
      return result;
    } catch (err) {
      toolObserver?.(name, err, performance.now() - start);
      if (name !== 'report_problem') onFailure({ tool: name, errorId: err instanceof UpstreamError ? err.errorId : null, at: Date.now() });
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

export function buildServer (
  { http = false, oauth = false, extraTools, platform }: { http?: boolean; oauth?: boolean; extraTools?: (server: McpServer) => void; platform?: Platform } = {}
): McpServer {
  // The last failed tool of this server, for report_problem's draft. One server per stdio process and per raw-mode
  // session (one person each); over OAuth a server lives for one request, so a failure in an earlier request is not seen.
  let lastFailure: LastFailure | null = null;
  const wrap = <T>(name: ToolName, handler: (a: T) => Promise<any>) => wrapTool(name, handler, (f) => { lastFailure = f; });

  const server = new McpServer({
    name: 'hds-mcp',
    version
  }, {
    instructions: 'Health Data Safe (HDS) account tools. ' + PRIVACY_DISCLOSURE +
      ' Always look data up in the HDS data model (search_items, get_item) before writing it.' +
      ' To import someone\'s medical history (documents, lab reports, photos, spreadsheets, app exports), read get_import_guide first.' +
      ' When no item fits their data, tell them and offer report_missing_item; when this connector itself fails, offer report_problem: it prepares a draft, and nothing is published until the person reviews and sends it.' +
      ' Account tasks (email, password, two-step sign-in, connected apps, consents, exporting or deleting the account) are ' +
      'done in the HDS account panel, not with these tools: call open_account and give the person its link.' +
      // OAuth: writes are consented per kind of data; a refused write is the person's consent, not a fault.
      (oauth
        ? ' The person consents per kind of data, and can widen it later. Before adding data, call get_connection: if the ' +
          'kind of data is not in what this connection may add to, tell the person which one the request needs and how to ' +
          'grant it, then wait. A write refused as Forbidden / insufficient_scope means the same, not a fault. ' + extendWriteHint([])
        : '') +
      // The remote MCP serves one platform; stdio connects to demo unless asked for prod.
      (platform
        ? ` ${platformNote(platform)} Tell the person which platform this is before the first read.`
        : ' connect uses the demo platform unless the person asks for production; call get_connection to tell them which one they are on.')
  });

  if (!http) {
    server.tool(
      'connect',
      'Connect to an HDS / Pryv account via OAuth. Opens your browser to sign in. Demo by default. For an import, pass roots (only the root streams it writes, from list_model_streams) and importName (its own app access, so every event names the import and it can be removed later); tell the user which kinds of data and which level the access covers before signing in. ' + PRIVACY_DISCLOSURE,
      connectInput,
      wrap('connect', connectHandler)
    );
  }

  server.tool(
    'list_streams',
    'List the streams (data containers) in the connected HDS account. Returns the stream tree.',
    listStreamsInput,
    wrap('list_streams', listStreamsHandler)
  );

  server.tool(
    'get_events',
    'Get events (data points) from the connected HDS account, optionally filtered by stream, type, time range, clientData.sourceKey prefix (everything one import wrote) or the event they cite (relatedTo). state: \'all\' includes trashed events, which a re-run must see and leave trashed. Pages with limit + skip.',
    getEventsInput,
    wrap('get_events', getEventsHandler)
  );

  server.tool(
    'create_event',
    'Create a single event (data point) in the connected HDS account. Always call search_items first to find the canonical HDS item for the data type, then get_item to read its spec, and use that streamId + eventType. If no item matches, ask the user before inventing a type. The content is checked against the eventType content schema before writing; an unknown type or invalid content is refused and nothing is written. Optional description (human text every app shows) and clientData (data-model conventions such as sourceKey). Refuses on production until the production-write gate is opened.',
    createEventInput,
    wrap('create_event', createEventHandler)
  );

  server.tool(
    'import_batch',
    'Import many events at once (1–500 per call). Always call search_items first to find the canonical HDS item for each data type, then get_item for its spec, and use those streamId + eventType values. If no item matches for some data, ask the user before inventing a type. Every event is checked against its eventType content schema first; if any fails, the whole batch is refused and nothing is written. Returns the created event ids in input order, so later events can reference earlier ones. Refuses on production until the production-write gate is opened.',
    importBatchInput,
    wrap('import_batch', importBatchHandler)
  );

  // Not over OAuth: its grants never carry manage, so stream creation is always refused there. Raw mode holds manage.
  if (!oauth) {
    server.tool(
      'ensure_streams',
      'Create the streams the given HDS items need in the connected account, with their data-model names, parents first (call before writing to items whose streams may not exist yet). Needs manage on the root. Refuses on production until the production-write gate is opened.',
      ensureStreamsInput,
      wrap('ensure_streams', ensureStreamsHandler)
    );
  }

  server.tool(
    'update_event',
    'Change one event in place (content, time, description, clientData, …), e.g. when an import runs again and a record changed: find it by clientData.sourceKey with get_events. Content is checked against the event type first. clientData is replaced whole: keep sourceKey. Never update a trashed event: the user removed it. Refuses on production until the production-write gate is opened.',
    updateEventInput,
    wrap('update_event', updateEventHandler)
  );

  server.tool(
    'delete_events',
    'Delete events by id, or everything one import wrote by clientData.sourceKey prefix. Without confirm: true it is a dry run that lists what would go: show the list to the user and only confirm after they agree. Deletes citing events before their sources. A first delete moves events to the trash; deleting trashed events removes them for good. Refuses on production until the production-write gate is opened.',
    deleteEventsInput,
    wrap('delete_events', deleteEventsHandler)
  );

  server.tool(
    'search_items',
    'Search the HDS data-model for items (the canonical, human-meaningful unit: a streamId + eventType + content shape). Use this BEFORE create_event or import_batch to find the right item. Searches labels in every language the model has (English, French), and terminology codes: a LOINC, SNOMED-CT, ICD-10 or ICF code finds the item that owns it (use the item, not a generic lab result, when one does). Deprecated items are hidden unless asked for. If a search returns no match for the user\'s data, surface that to the user — do not fall back to inventing types — and offer report_missing_item.',
    searchItemsInput,
    wrap('search_items', searchItemsHandler)
  );

  server.tool(
    'get_item',
    'Get the full definition of a single HDS item by key (e.g. "body-weight"). Call this after search_items to read the spec before writing events. Returns the canonical streamId, eventType (or the unit choices), scale/unit/options if any, the content schema of each eventType, and the data-model version.',
    getItemInput,
    wrap('get_item', getItemHandler)
  );

  server.tool(
    'get_event_type',
    'Get one HDS event type: its content schema (what create_event / import_batch accept), the unit name for measurement types, whether it needs an attachment, and the items that use it. Reads the data model only; no account needed.',
    getEventTypeInput,
    wrap('get_event_type', getEventTypeHandler)
  );

  server.tool(
    'list_model_streams',
    'Browse the stream tree of the HDS data model: the root streams (the consent units apps ask access to) or the children of one stream, with the items each holds. This is the model, not the user\'s account: use list_streams for the account. No account needed.',
    listModelStreamsInput,
    wrap('list_model_streams', listModelStreamsHandler)
  );

  server.tool(
    'list_datasources',
    'List the HDS datasets (curated, coded lists: conditions, findings, medications, procedures, treatments) and the items that take a value from each. Use search_dataset to look up an entry. No account needed.',
    listDatasourcesInput,
    wrap('list_datasources', listDatasourcesHandler)
  );

  server.tool(
    'search_dataset',
    'Search an HDS dataset (from list_datasources) for a coded entry, e.g. a diagnosis for condition-coded or a drug for medication-intake-coded, and get its label, codes (SNOMED-CT, ATC, RxNorm, …) and hdsId to store unchanged in the item\'s content. The search text is sent to the HDS datasets service of the connected platform (demo when not connected); tell the user when the text names their condition or medication. The lists are curated and incomplete: on no match, tell the user, never invent a code.',
    searchDatasetInput,
    wrap('search_dataset', searchDatasetHandler)
  );

  server.tool(
    'get_connection',
    'Which HDS platform this session uses (production = the person\'s real health record; demo = a test platform for trying things out with a throwaway account) and whether it is connected. Tell the person before the first read or write.',
    getConnectionInput,
    wrap('get_connection', getConnectionHandler)
  );

  server.tool(
    'get_import_guide',
    'How to import a person\'s medical history (documents, lab reports, photos, spreadsheets, app exports) into HDS: the steps, the rules for each source type, and what to do when no item fits. Call it with no topic before the first import, then with the topic of each source. No account needed.',
    getImportGuideInput,
    wrap('get_import_guide', getImportGuideHandler)
  );

  server.tool(
    'report_missing_item',
    'When no HDS item fits the user\'s data (search_items found nothing suitable), prepare a report asking HDS to add one: returns a prefilled GitHub issue link (site-agents, data-model gap) for the user to open and post themselves; nothing is sent by this tool. Offer it to the user, and put only the kind of data, its unit and known codes in it: never their values, names, dates or file names.',
    reportMissingItemInput,
    wrap('report_missing_item', reportMissingItemHandler)
  );

  server.tool(
    'report_problem',
    'When this connector fails in a way the person cannot fix (a tool error, a refused sign-in, wrong behaviour), prepare a problem report for the HDS team: returns a link to the draft (an HDS review page, or a prefilled GitHub issue on site-agents) for the person to read, edit and send themselves; nothing is sent by this tool. Put only what was asked and the error as-is: never their health data, names, account name or links.',
    reportProblemInput,
    wrap('report_problem', (input: Parameters<typeof reportProblemHandler>[0]) => reportProblemHandler(input, lastFailure))
  );

  server.tool(
    'open_account',
    'When the person wants to change their email or password, reset a forgotten password, set up two-step sign-in, see or revoke connected apps, change consents, or export or delete their account: returns a link to the HDS account panel of this platform at that page, with their username filled in at sign-in when connected. The person does it there; nothing is changed by this tool.',
    openAccountInput,
    wrap('open_account', openAccountHandler)
  );

  // Raw HTTP mode adds its own connect / connect_status / disconnect.
  extraTools?.(server);
  return server;
}
