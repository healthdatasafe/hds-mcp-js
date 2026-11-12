# Changelog

## [Unreleased]

## [0.23.0] - 2026-11-12

### Changed
- `report_problem` signs the connected account's username (as `access-info` states it) with the source key, as `idt`
  beside `att` in the review draft (hds-issues-service 0.2.0). The review page offers "add my HDS username" read-only
  from it and sends it only when ticked; `att` still names nobody. No idt when the core does not answer, or without a
  key or a session.
- A local (stdio) MCP sends `report_problem` drafts to the HDS issue intake `https://issues.hds.ngo` when
  `HDS_MCP_ISSUES_URL` is unset (it has no source key, so reports arrive as anonymous). An explicit value wins; an
  empty string keeps the GitHub link. The HTTP server is unchanged: it still needs the variable set.

## [0.22.0] - 2026-11-11

### Changed
- Genetic results (plan 115, REVIEW-2026-11-11-GENETICS-FABLE): the OAuth instructions tell the assistant genetic
  results are off by default and never to ask for them unless the person asked to read or add genetic results; the
  write hint says the person *ticks* "Add and modify …" on the consent screen (genetic results come unticked). The
  connector rows can carry `hds/stream/genetics.contribute` in `HDS_MCP_SCOPES` once the core's extension offers it
  unticked (hds-fhir-js `explicitGrantOnly`).

## [0.21.1] - 2026-11-10

### Security
- Production dependency advisories fixed (`npm audit --omit=dev`: 5 high + 1 moderate → 0):
  `@modelcontextprotocol/sdk` 1.29.0 → 1.32.2, `hono`, `@hono/node-server`, `ip-address`, `fast-uri` (lockfile), and
  `zod` 3.25 → 4.6.7 (GHSA-mrhx-c7xc-m3w5, unbounded allocation when validating oversized constrained collections;
  no 3.x fix exists). The SDK accepts `zod ^3.25 || ^4.0`.
- Advertised tool input schemas are unchanged in their properties. Under zod 4 they no longer carry
  `additionalProperties: false` (unknown keys are still stripped at runtime, as before), integers gain an explicit
  safe-integer bound, and records gain `propertyNames: { type: string }`.

## [0.21.0] - 2026-11-10

### Added
- `report_problem` can hand the person the HDS issue intake's review page instead of a GitHub link: with
  `HDS_MCP_ISSUES_URL` set (the intake's https base URL), it returns `<url>/new#<draft>`, the draft (title, body,
  MCP version, platform) base64url-encoded in the URL fragment, which no browser sends to a server. The person reads,
  edits and sends it from that page, with no account. With `HDS_MCP_ISSUES_KEY` and `HDS_MCP_ISSUES_KEY_ID` (a
  deployed MCP's source key and its id on the intake) and a signed-in session, the draft carries an HMAC attestation
  that only says an HDS session existed: no username, no token. Without `HDS_MCP_ISSUES_URL`, the GitHub link as
  before. A key without its id, a key under 16 characters or a non-https URL stops the HTTP server at start.
- The drafted body names the last tool that failed in the session and the core's error id when it gave one (stdio
  and raw mode; over OAuth each request is its own session, so the agent's own words carry it).

### Changed
- `report_problem` says "A draft was prepared; nothing is published until the person reviews and sends it" in both
  modes (was "Nothing has been sent"); the server instructions and the tool description say the same.
- The report scrub reduces any URL with credentials to scheme + host (`https://***@{username}.api.datasafe.dev/`,
  path and query dropped) and masks `Authorization:` / `Cookie:` headers and secret JSON keys, the same output as the
  intake's own scrub, which runs again before anything is filed.
- CI runs on ubuntu-24.04.

## [0.20.0] - 2026-11-09

### Fixed
- `report_problem` scrubs every free-text field before building the public GitHub link: tokens (URL userinfo,
  `Bearer`, `auth=` and other token parameters), emails, per-user addresses (`{username}.api.datasafe.dev`), query
  strings and fragments, long opaque ids, and the connected account's name. Logs and tool errors now also mask
  `Bearer` values and token parameters (B-2026-11-09-10).
- Every outbound call of the tools (core API, sign-in, service info, data-model pack, datasets) has a timeout (60 s
  core API, 30 s pack, 10 s otherwise) and never follows a redirect (B-2026-11-09-11). A failed pack load is
  retried by the next call instead of being kept until restart.
- Telemetry: a failed tool call (an HTTP 200 with `isError`) is now counted: `tool <name>` / `error` in `hds.calls`,
  its kind in `hds.errors` (B-2026-11-09-12). New codes `RATE_LIMITED` (429) and `TOOL_ERROR` (the tool refused);
  502/503/504 and an upstream 5xx are `UPSTREAM_ERROR`, other 4xx `BAD_REQUEST` (B-2026-11-05-8, as lib-bridge-js
  0.16.1).
- Docs: the README lists all nineteen tools, AGENTS.md says raw mode offers `ensure_streams`, and `engines` asks for
  Node ≥ 22.18, which runs the `.ts` scripts directly (B-2026-11-09-13).

## [0.19.2] - 2026-11-09

### Fixed
- A 421 from the core (a token from another core at introspection or token exchange, a moved account in raw mode)
  is handled as an answer again instead of a thrown "fetch failed": the core calls used `redirect: 'error'`, with
  which Node's fetch fails any 421 (B-2026-11-09-1). Redirects are still never followed (`redirect: 'manual'`, a 3xx
  is an error), so a token is never re-posted off the issuer's host.

## [0.19.1] - 2026-11-06

### Fixed
- Raw mode offers `ensure_streams` again: it was hidden on every HTTP session because OAuth grants never carry manage,
  but raw mode's access is `*` at manage, so a write to an item whose stream did not exist yet could not be done.
  Still hidden over OAuth.

## [0.19.0] - 2026-11-06

### Added
- `open_account`: account tasks these tools do not do (change email or password, reset a forgotten password, two-step
  sign-in, connected apps, consents, export or delete the account) get a link to the HDS account panel of the
  session's platform (`account.hds.ngo` / `demo-account.datasafe.dev`) at the task's page, with the username from
  `access-info` prefilled at sign-in (perki 2026-11-06). The server instructions route these requests to it.

## [0.18.0] - 2026-11-06

### Changed
- Per-user addresses follow the core's addressing (open-pryv.io R11, rc.75): the account and base come from the
  `X-Adapter-Name` / `X-Adapter-Base` headers the core sets, no longer from the Host. The manifest adds `baseTemplate`.

### Added
- The assistant knows how write consent is widened (perki 2026-11-06: uploading is the first use case; Claude.ai
  ignores the step-up challenge and only shows "Forbidden"). Over OAuth, `get_connection` lists what the connection
  may add to and only read, by name; the server instructions say to check it before a write and, when the request
  needs another kind of data, to tell the person to reconnect and keep "Add and modify <name>" ticked. The 403
  step-up answer keeps its `WWW-Authenticate` challenge and now carries a JSON-RPC error saying the same.
- Token exchange sends `subject_token_resource` (open-pryv.io R10, rc.75; older cores ignore it): the address the token
  was presented at, the region address or the per-user one, so the core refuses a token issued for another
  address. Exchange answers are cached by token and resource.

## [0.17.0] - 2026-11-06

### Added
- Per-user addresses (off unless `HDS_MCP_PER_USER_DOMAIN` is set, e.g. `api.datasafe.dev`; needs token exchange):
  on `https://<username>.<domain>/adapter/mcp/mcp` the RFC 9728 metadata, the 401 / 403 challenges and raw-mode
  sessions name that host, and the manifest gives `mcpEndpointTemplate` / `rawEndpointTemplate`. Waits for the core's
  per-user audience (open-pryv.io R10) before it is switched on.

### Changed
- `get_import_guide` letter topic follows data-model 3.46.0: an uncoded prescription goes to
  `medication-prescription-basic`; regimens carry `timeOfDay` or `when` and `bounds`; `stopReason` / prescription
  `status: stopped`; no `status: skipped` on intakes until the readers ship.

## [0.16.1] - 2026-11-05

### Fixed
- Raw mode on production: `connect` refused every sign-in ("unexpected answer") because the register's poll URL sits
  on the person's core (`core-ch1.api.datasafe.dev`) while the access URL is `access.api.datasafe.dev`. The poll URL
  may now be on a host under the access host's parent domain (not a bare registrable domain); any other host is still
  refused. Demo was unaffected (one host).

## [0.16.0] - 2026-11-05

### Changed
- Ready for a production MCP: instead of refusing every production account, each MCP serves its own platform only
  (from `HDS_MCP_SERVICE_INFO`) and refuses accounts of the other; on a production MCP, writes are gated by the
  consent given at sign-in rather than the stdio opt-in. A production MCP refuses to start without
  `HDS_MCP_TOKEN_EXCHANGE=true`.

## [0.15.0] - 2026-11-05

### Added
- `report_problem`: when the connector itself fails, a prefilled "Agent problem" issue link (site-agents) for the
  person to post, with the MCP version; no personal data. The server instructions mention it.

### Changed
- Raw mode: while a sign-in is pending, `connect_status` says HDS has not received the acceptance yet, how long the
  link stays valid, and what to do if the person closed the page early.

## [0.14.1] - 2026-11-05

### Fixed
- Raw mode: the access check accepts what the core adds to every app access (masks at level `none`, such as
  `:_system:account:` and genetics, and a read of the access's own audit stream); any other extra is still refused.

## [0.14.0] - 2026-11-05

### Changed
- Raw mode asks for a master access (`*`, manage) instead of one permission per data root: one consent line. The platform
  masks genetics under `*` (an explicit-grant-only theme), as the OAuth connector leaves it out.

## [0.13.1] - 2026-11-04

### Fixed
- Raw mode: when the core falls back from the one-time hand-off to inline delivery with the token beside a token-less
  `apiEndpoint`, sign-in now works (it was refused); the access is verified as before.

## [0.13.0] - 2026-11-04

### Added
- `get_connection`: which HDS platform the session uses (production = the person's real record; demo = a test
  platform) and whether it is connected. The remote MCP's server instructions and manifest (`platform`) name its
  platform; `connect` and raw `connect_status` name it too. The guidance suggests a throwaway demo account with
  made-up values to try things out (https://demo-account.datasafe.dev/register), never real records.

## [0.12.0] - 2026-11-04

### Added
- The adapter manifest names the raw-mode address (`rawEndpoint`) when raw mode is on, so the account app's AI
  assistant tab can offer it to assistants without a Client ID field.

### Fixed
- Raw mode: an access refused after its credential was retrieved (wrong app, device name, permissions, expiry or a
  production host) is now deleted at the core, not left alive for 4 hours; a `disconnect` during a sign-in poll no
  longer breaks it and waits for it to finish; shutdown revokes fit within the container's stop grace.

## [0.11.0] - 2026-11-04

### Added
- `get_import_guide`: how to import someone's medical history (overview, lab reports, letters, photos,
  spreadsheets, app exports, and what to do when no item fits), from the agent docs and the data-model docs. The
  server instructions point to it.
- `report_missing_item`: a prefilled data-model-gap issue link on site-agents for the person to post; it carries
  the kind of data, unit and codes, never their values. No-match answers of `search_items` offer it.
- Remote MCP: step-up. A write (`create_event`, `import_batch`) to a data root the token can only read answers
  403 `insufficient_scope` naming `hds/stream/<root>.contribute`, so the client asks the person for write
  consent on that root at the first write.
- Remote MCP: raw mode (`HDS_MCP_RAW=true`, at `<base>raw`): for clients without the connector OAuth. `connect`
  returns the platform's sign-in link; the session then holds an access to every data root (manage, genetics left
  out) that the core expires after 4 h; `connect_status`, `disconnect` (deletes the access). The accepted access
  is verified before use, and the token comes through a one-time shared secret.

### Fixed
- `search_items` description lists every code system it searches (ICD-10 and ICF too).

## [0.10.0] - 2026-11-04

### Added
- Sidecar deployment behind a Pryv core (adapter contract rule 5): when `HDS_MCP_PUBLIC_URL` has a path such as
  `/adapter/mcp/mcp`, the manifest is served under its folder (`/adapter/mcp/manifest.json`), where the core
  forwards, and `/status` there as well as at the root. A public URL of `/mcp` behaves as before.

## [0.9.0] - 2026-11-04

### Added
- `HDS_MCP_TOKEN_EXCHANGE=true` (off by default): the connector's token is exchanged at the core's token endpoint
  (OAuth 2.0 Token Exchange, RFC 8693) for a derived token of the same grant, and the tools call the API with that
  token instead of passing the connector's through. Needs a core with token exchange and the MCP's client row
  flagged for it. Dead or foreign tokens answer 401 with `resource_metadata`; exchange faults on the server side
  answer 500 and are logged.

### Fixed
- The token cache no longer keeps expired entries: they are dropped on each cache miss.

### Security
- Introspection and token exchange refuse redirects, so a token is never re-posted off the issuer's host.

## [0.8.1] - 2026-11-04

Hardening from the plan 115 Fable security review (2026-11-04, S-3 and S-8).

### Changed
- A token whose introspection carries no `aud` is refused by default. `HDS_MCP_REQUIRE_AUDIENCE=false` restores the
  old behaviour (a core older than rc.70, or connector rows without `--audience`); `true` or unset = refuse.

### Security
- 10 s timeout on the authorization server metadata fetch and on every introspection call, so a stalled core cannot
  pin sockets.
- The introspection endpoint, where the client secret is posted, must be https on the issuer's own host; startup
  fails otherwise.
- `api_base` from introspection must be https.

## [0.8.0] - 2026-11-04

### Changed
- `connect` with no `roots` no longer requests `*`. It requests one permission per data-model root at the asked
  level, leaving out the roots the pack marks `explicitGrantOnly` (today `genetics`), which only `roots` naming them
  can reach (site-agents#37). The sign-in creates any missing model root, as `roots` already did; streams outside
  the data model are no longer covered by the default access. The reply names the excluded roots.

## [0.7.1] - 2026-11-03

### Added
- `HDS_MCP_SCOPES` (space-separated): published as `scopes_supported` in the protected-resource metadata. A client
  that names no scope asks for this list (MCP spec); Claude Code does, and the core refuses an empty scope
  (`invalid_scope`). Unset = no `scopes_supported`, as before.

## [0.7.0] - 2026-11-02

Discovery groundwork and tighter remote surface (plan 118).

### Added
- `GET /manifest.json` on `hds-mcp-http`: a Pryv adapter manifest (adapter contract §3: `name`, `type: "mcp"`,
  `version`, plus `mcpEndpoint`, `protectedResourceMetadata`, `authorizationServer` and the public connector
  `clients` ids from `HDS_MCP_CONNECTOR_CLIENTS`). Public, readable from any origin, so a core can list this server
  in `/service/info` `adapters` and the account app can read the URL for the user's core. Nothing lists it yet.
- `HDS_MCP_REQUIRE_AUDIENCE=true`: refuse tokens whose introspection carries no `aud`. Turn it on once the core
  echoes `aud` (rc.70) and the connector rows carry `--audience`.

### Changed
- `ensure_streams` is no longer offered over HTTP: OAuth grants never carry `manage`, so it could only fail there.

## [0.6.0] - 2026-11-02

CI-built image for the remote transport (plan 118, plan 102 procedure), deployed on demo at `demo-mcp.datasafe.dev`.

### Added
- `GET /status` on `hds-mcp-http`: `{ status: 'ok', name, version }`, no auth, before the Origin check. Used by the
  Dokku startup healthcheck (`app.json`) and by `deploy-image.sh`, which asserts `version`.
- Aggregate telemetry through `hds-observability-js` (an **optional** git dependency, no vendor agent, so a stdio
  install never needs it: it is loaded at runtime and declared locally for the compiler, and the image smoke test
  asserts it is present): call counts and durations per
  registered route (`POST|GET|DELETE <mcp path>`, `GET /status`, the two `.well-known` metadata routes) and error
  counts by a closed set of codes derived from the HTTP status. Off unless `HDS_OTEL_ENDPOINT` is set; the stdio
  server never loads it. Last window flushed on SIGTERM.
- Image build: `Dockerfile` (builds `dist/` in the image, runs `node dist/httpMain.js` as uid 32767 on port 7450),
  `.dockerignore`, `app.json`, `.github/workflows/build-image.yml` (`ghcr.io/healthdatasafe/hds-mcp-js`, tests on,
  smoke-imports `dist/` in the image) and `prune-images.yml`.
- `npm run typecheck`.

## [0.5.0] - 2026-11-02

Remote transport, preview, demo only (plan 118 phase 3a). Not deployed: the end-to-end spike needs core registry rows from
plan 115.

### Added
- `hds-mcp-http` (`src/httpMain.ts`): the same tools over Streamable HTTP, stateless, one server per request, for a
  deployment next to an HDS core. OAuth resource server only: it serves RFC 9728 protected-resource metadata naming
  the core's issuer, and validates bearer tokens through the core's RFC 7662 introspection (confidential client,
  60 s cache, audience checked when the token carries one). Production accounts are refused until token exchange
  lands (plan 118 decision). Origin check; GET / DELETE answer 405; no `connect` tool over HTTP.
- Server `instructions` carry the privacy disclosure, so it reaches clients on both transports.

### Changed
- Credentials are now per request (AsyncLocalStorage) on the HTTP transport; stdio keeps one session per process.
  Tests prove interleaved requests never see each other's token.

## [0.4.0] - 2026-11-02

Scoped access and read-back for imports (site-agents#36 A3, A6; plan 118 phase 2), following the import contract of
`llms-full.txt` §5f.

### Added
- `connect` takes `roots` (only the root streams an import needs, each with a level, default `manage`, named from the
  data model so the consent screen shows plain names; no `*`) and `importName` (the session signs in as its own app
  access `hds-mcp-<importName>`, so every event names the import as its author).
- `get_events`: `state` (`all` shows trashed events, which a re-run must leave trashed), `sourceKeyPrefix` and
  `relatedTo` clientData filters (whole 1900-2100 range by default when filtering), `skip` paging with a
  "more may exist" hint.
- `ensure_streams`: creates the streams the given items need, parents first, with their data-model names.
- `update_event`: changes one event in place; content is validated against its type first.
- `delete_events`: by ids or by `sourceKeyPrefix`; a dry run listing what would go unless `confirm: true`; deletes
  citing events before their sources; a second delete removes trashed events for good.

### Fixed
- `get_item` description cited a non-existent example key (`fertility-bbt`); now `body-temperature-basal`.

## [0.3.0] - 2026-11-02

Data model and datasets read tools (site-agents#36 A7 in part).

### Added
- `search_items` searches labels in every pack locale (`lang` picks the one shown) and terminology codes: a LOINC,
  SNOMED-CT, ICD-10 or ICF code finds the item that owns it, from `references` (including `loincMethod`),
  per-unit `loinc`, and `fhir.code` / `fhir.alsoMatch` in both their plain and per-eventType shapes. Results list
  the codes. Deprecated items are hidden unless `includeDeprecated: true`.
- `get_event_type`: an eventType's content schema, unit name, attachment flag and the items using it.
- `list_model_streams`: the data model's stream tree (roots or one stream's children) with the items per stream.
- `list_datasources`: the HDS datasets and the items each one feeds.
- `search_dataset`: search a dataset (condition, finding, medication, procedure, treatment) for a coded entry.
  The endpoint is resolved like hds-lib, from `assets.datasets` of the connected platform's service-info (demo
  when not connected). The tool description tells the agent the search text reaches the HDS datasets service.
- `connect` remembers the platform's service-info URL for the session.

## [0.2.0] - 2026-11-02

Driven by [site-agents#36](https://github.com/healthdatasafe/site-agents/issues/36) (A1, A2, A12).

### Added
- `create_event` / `import_batch` accept `description` and `clientData`, so the data-model conventions
  (`sourceKey` / `related` provenance, `hdsTimePrecision` partial dates, `hdsRefRange` / `hdsFlag` /
  `hdsComparator` lab values as printed) can be written through the MCP.
- Content is validated before writing against the eventType's JSON Schema from the pack (ajv draft-04, the
  options the data-model uses for the cores). Unknown types, invalid content and attachment-only types are
  refused with nothing written; one invalid event refuses the whole batch.
- `import_batch` returns the created event ids in input order (`null` where the core refused one).
- `get_item` returns the eventType(s), including an item's unit choices, with each eventType's content schema.
- The data-model version the MCP loaded is shown by `search_items`, `get_item` and the load log.
- `connect` description: tell the user who sees what before reading any record, again before a first
  production read.

### Fixed
- `search_items` threw on every call (`Cannot read properties of undefined (reading 'toLowerCase')`): 63 items
  carry their eventType only as unit choices (`variations.eventType`). `get_item` showed `eventType: undefined`
  for the same items.

## [0.1.0] - 2026-06-11

### Changed — production writes become a per-session user opt-in

- `connect` gains `enableWrites: boolean` — `connect({ host: "prod", enableWrites: true })`
  unlocks `create_event` / `import_batch` on the production host for the
  lifetime of the session. The tool description instructs agents to pass it
  only when the user explicitly asked to write to their production account.
- The prod-write refusal error now explains how to opt in (re-run `connect`
  with `enableWrites: true`).
- `HDS_MCP_PROD_WRITES_ENABLED=true` remains as a global (operator) override.
- Session flag resets on every restart; demo writes unchanged (always allowed).

## [0.0.7] - 2026-06-10

### Added — one-line install from GitHub

- Ships compiled JS: `tsconfig.build.json` emits `dist/` (built on install via
  `prepare`), `bin`/`main` point at `dist/index.js`. Fixes
  `npx -y github:healthdatasafe/hds-mcp-js` (Node refuses to type-strip TS
  under `node_modules`, so the previous `bin → src/index.ts` could never run
  via npx).

### Fixed

- `serverInfo.version` was hardcoded; now read from `package.json` at runtime.
- eslint flat-config global `ignores` was combined with other keys and ignored
  nothing; `dist/` is now actually excluded.

## [0.0.6] - 2026-06-01

- `connect` default permission level `read` → `contribute` (a read-only token
  made `import_batch` fail with `forbidden`).
- New `AGENTS.md` (canonical agent-onboarding doc: design choices, tool
  catalogue, itemDef-first rule, error shapes, extension guide).

## [0.0.5] - 2026-06-01

- Fix Pryv poll-mode auth: POST to the bare `info.access` URL with
  `requestingAppId` in the body (POSTing to `info.access + appId` returns
  HTTP 400); read `poll_rate_ms` (snake_case) instead of `pollRateMs`.

## [0.0.4] - 2026-06-01

- itemDef-first priming in tool descriptions: `create_event` / `import_batch`
  lead with "call `search_items` first; ask, don't invent"; `search_items`
  says what to do on miss. Description-only, no schema changes.

## [0.0.3] - 2026-05-31

- `search_items` + `get_item` backed by `model.datasafe.dev/pack.json`
  (fetched + cached). Fixed service-info URLs (demo:
  `demo.datasafe.dev/reg/service/info`, prod:
  `reg.api.datasafe.dev/service/info`).

## [0.0.2] - 2026-05-30

- `create_event` + `import_batch` (1–500 events), gated off on production;
  `apiPost` / `apiBatch` helpers.

## [0.0.1] - 2026-05-30

- Initial stdio MCP server: `connect` (Pryv poll-mode OAuth, no callback URL),
  `list_streams`, `get_events`; centralised token scrubber (unit-tested);
  demo-default host policy; in-memory token.
