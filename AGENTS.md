# Agent primer — hds-mcp-js

This file orients agents (Claude or others) working **on** `hds-mcp-js` or
**through** it. The end-user [`README.md`](README.md) is for humans
installing the MCP into Claude Desktop; this file is for agents that need
to understand the tool surface, the rules baked into the tool
descriptions, and the design choices behind them.

If you are an agent that **consumes** `hds-mcp` (Claude Desktop, ChatGPT
desktop, …), the canonical reference is the agents site:
<https://agents.datasafe.dev> and
<https://agents.datasafe.dev/llms-full.txt>. Read this AGENTS.md
when you are editing the MCP code itself.

---

## What `hds-mcp` is (and is not)

`hds-mcp` is a stdio MCP server that exposes Health Data Safe (HDS) /
Pryv operations to AI agents. It is **deliberately thin** — it does not
ship filesystem I/O, OCR, vision, Excel parsing, or any composition
beyond mapping MCP tool calls to Pryv API calls. The agent's client is
expected to provide everything else.

Design choices (locked during the v1 scoping; tracked in the project's
planning issues — see [healthdatasafe/_macro#23](https://github.com/healthdatasafe/_macro/issues/23)):

- **Hand-written tool surface for v1.** Auto-generation from
  `hds-lib-js` + `hds-forms-js` types is the v0.5 goal. Hand-writing the
  essential 7 surfaces real auth + description bugs that auto-gen would
  have masked behind library-internals churn.
- **Demo by default.** `connect` with no `host` arg targets
  `demo.datasafe.dev`. Production needs an explicit `host: "prod"`.
- **In-memory tokens.** No disk, no keychain. Re-OAuth on every restart.
- **Centralised token scrubber.** Every log / error / telemetry path
  runs through [`lib/scrubber.ts`](src/lib/scrubber.ts). Unit-tested.
  Hard rule — do not add a `console.log` or `process.stderr.write`
  that bypasses it.
- **Production-write gate (session opt-in since v0.1.0).** `create_event`
  and `import_batch` refuse on prod hosts unless the session was opened
  with `connect({ host: "prod", enableWrites: true })` — which the agent
  may only pass when the user explicitly asked to write to production.
  `HDS_MCP_PROD_WRITES_ENABLED=true` in the MCP environment remains as a
  global override. Enforced in
  [`lib/hostPolicy.ts`](src/lib/hostPolicy.ts) +
  [`lib/apiCall.ts`](src/lib/apiCall.ts); the session flag lives in
  [`auth/session.ts`](src/auth/session.ts) and resets on every restart.
- **No mutation gating at the MCP layer** beyond the prod-write gate —
  rely on the client's per-tool-call permission prompt (Claude Desktop /
  ChatGPT already do this).

---

## Tool catalogue (v0.4.0, tier=essential)

All fourteen tools are tagged `essential` and exposed by default. The
`extended` and `advanced` tiers are reserved for the v0.5 auto-gen pass.

| Tool                  | Purpose                                                                 | Notable behaviour                                                                                                                                                                                                                                                                                                                  |
|-----------------------|-------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **`connect`**         | OAuth (Pryv poll-mode) — opens browser, polls until accept              | Defaults: `host: "demo"`, `level: "contribute"`, scope **all data**: one permission per data-model root, minus the roots marked `explicitGrantOnly` (`genetics`), never `*` (site-agents#37; a `level: 'none'` mask next to `*` would create the masked stream at sign-in). `roots: [{ streamId, level? }]` scopes the access to those roots (default level `manage`, `defaultName` from the pack, `*` refused); `importName` signs in as its own app access `hds-mcp-<importName>` (llms-full §5f.2-3). Other levels: `read`, `manage`. `enableWrites: true` (only with `host: "prod"`, only on the user's explicit ask) unlocks prod writes for the session. Returns `apiEndpoint` (held in-memory in [`auth/session.ts`](src/auth/session.ts)). |
| **`list_streams`**    | List the user's stream tree                                             | Reads always allowed on demo + prod.                                                                                                                                                                                                                                                                                               |
| **`get_events`**      | Query events, filtered by stream / type / time range                    | Reads always allowed on demo + prod. Batch `events.get`, so `state`, `skip` and clientData conditions pass through: `sourceKeyPrefix` (`{ path: 'sourceKey', prefix }`), `relatedTo` (`{ path: 'related.<id>', exists: true }`); a clientData filter without times searches 1900-2100.                                                                                                                                                                                                                                                                                               |
| **`ensure_streams`**  | Create the model streams given items need, parents first                | Gated on prod. Reads `streams.get` (state all), creates only the missing ones with data-model names.                                                                                                                                                                                                                             |
| **`update_event`**    | Change one event in place                                               | Gated on prod. Validates content against the (new or current) type via `events.getOne` first. `clientData` is replaced whole.                                                                                                                                                                                                    |
| **`delete_events`**   | Delete by ids or by `sourceKeyPrefix`                                   | Gated on prod. Dry run unless `confirm: true`; citing events (those with `clientData.related` to another in the set) go before their sources; first delete trashes, second deletes for good.                                                                                                                                      |
| **`search_items`**    | Search the HDS data-model catalogue                                     | Backed by [`dataModel/pack.ts`](src/dataModel/pack.ts) which fetches + caches `model.datasafe.dev/pack.json`. Scoring in [`tools/searchItems.ts`](src/tools/searchItems.ts) — exact-key match > exact code match (LOINC / SNOMED-CT / ICD-10 / ICF from `references`, per-unit `loinc`, `fhir.code` / `alsoMatch`: [`dataModel/codes.ts`](src/dataModel/codes.ts)) > exact-label match (any locale) > substring matches. `lang` picks the label language; deprecated items hidden unless `includeDeprecated`.                                                                                              |
| **`get_item`**        | Get one HDS item's full definition by key                               | Pulls from the same cached pack. Returns localised label/description, `streamId`, `eventType` (or `variations.eventType.options[]`), `type`, the content schema of each eventType and the data-model version (resolution in [`dataModel/eventTypes.ts`](src/dataModel/eventTypes.ts)).                                                                                                                                                                                       |
| **`get_event_type`**  | One eventType: content schema, unit name, attachment flag, items using it | Pack only, no account needed.                                                                                                                                                                                                                                                                                                    |
| **`list_model_streams`** | Browse the model's stream tree (roots or one stream's children) with items per stream | Pack only. Not the user's account (`list_streams` is).                                                                                                                                                                                                                                                         |
| **`list_datasources`** | The HDS datasets and the items fed by each                             | Pack only.                                                                                                                                                                                                                                                                                                                       |
| **`search_dataset`**  | Search one dataset (condition, finding, medication, procedure, treatment) | Endpoint resolved like hds-lib: `datasets://<kind>` joined to `assets.datasets` of the connected platform's service-info, demo when not connected ([`dataModel/datasources.ts`](src/dataModel/datasources.ts)). The search text reaches the HDS datasets service; the description tells the agent to say so. |
| **`create_event`**    | Create one event                                                        | **Gated** on prod hosts via `assertWriteAllowed`. Description primes the agent to call `search_items` → `get_item` first. Takes optional `description` and `clientData`. Type + content validated against the pack before the call (`validateEvent`); refused with nothing written.                                                                                                                                                                                                          |
| **`import_batch`**    | Create 1–500 events in one call                                         | Same gate. Same itemDef-first priming. Same fields and validation; one invalid event refuses the whole batch. Returns the created ids in input order (`null` where the core refused one).                                                                                                                                                                                                                                                                                             |

### Tool descriptions are part of the surface

The descriptions in [`src/server.ts`](src/server.ts) are not throwaway —
they are the **only signal** an agent receives when picking a tool from
the catalogue. Every change to a description is a behavioural change.
Key directives baked in:

- **itemDef-first**: `create_event` and `import_batch` lead with
  *"Always call `search_items` first to find the canonical HDS item …
  If no item matches, ask the user before inventing a type."* — without
  this, agents land first on the verb (`create / import`) and skip the
  data-model lookup, breaking the HealthKit / FHIR / SNOMED CT mapping
  HDS items carry.
- **Refuse-on-miss**: `search_items` says *"If a search returns no
  match, surface that to the user — do not fall back to inventing
  types."* Same reason.
- **streamIds distinction**: `create_event.streamIds` distinguishes
  HDS items (`get_item` is the source) from user-created streams
  (`list_streams` is the source).

---

## itemDef-first rule (canonical)

Whenever the user asks the agent to record or import health data:

```
1. search_items(query)           → find candidate items
2. get_item(key)                  → read its spec
3. create_event / import_batch    → use the item's streamId + eventType
```

Skipping steps 1–2 and inventing `streamId`s / `type` strings breaks
cross-system compatibility. The MCP tool descriptions enforce this; if
you are editing them, do not weaken that signal.

If no item matches, surface that to the user — the MCP does not invent.

---

## Error shapes (verbatim, as of v0.2.0)

| Trigger                                       | Message                                                                                  |
|-----------------------------------------------|------------------------------------------------------------------------------------------|
| No `connect` called yet                       | ``Not connected. Run the `hds.connect` tool first.``                                     |
| Unknown host alias                            | ``Unrecognised host: X. Use 'demo', 'prod', or a full service-info URL.``                |
| Prod write while gate is closed               | ``Writes to the production HDS host are disabled for this session. If the user explicitly asked to write to their production account, re-run connect with { host: 'prod', enableWrites: true } …`` |
| OAuth refused                                 | ``auth refused: <reason>``                                                               |
| OAuth poll timed out                          | ``auth timed out — please re-run hds.connect``                                           |
| Pryv API (GET) error                          | ``Pryv <path> failed: <upstream message>``                                               |
| Pryv API (POST) error                         | ``Pryv POST <path> failed: <upstream message>``                                          |
| Pryv batch error                              | ``Pryv batch failed: <upstream message>``                                                |
| Item key not found in pack.json               | ``No HDS item found for key "X".`` (with optional ``Did you mean one of: …?`` hint)      |
| `create_event`: type or content invalid       | ``Event refused, nothing written: <problems>``                                           |
| `import_batch`: any event invalid             | ``Batch refused, nothing written: N problem(s).`` then one ``- [index] <problem>`` line each (first 20) |
| Problem: type not in the data model           | ``Unknown event type "X": not in the HDS data model (data-model <version>). Use the eventType from get_item.`` |
| Problem: type needs an attachment             | ``Event type "X" needs an attachment, which this MCP cannot upload yet.``                |
| Problem: content does not match the schema    | ``content<path> <message> (<params>)``, e.g. ``content must be number ({"type":"number"})`` |
| `get_event_type`: unknown type                | ``No HDS event type "X" in data-model <version>. Use search_items to find the item, then its eventType.`` |
| `list_model_streams`: unknown parent          | ``No stream "X" in the HDS data model (data-model <version>).``                          |
| `search_dataset`: unknown datasource          | ``No datasource "X" in data-model <version>. Available: <keys>.``                        |
| `search_dataset`: text too short              | ``Search text too short for "X": at least N characters.``                                |
| `search_dataset`: service error               | ``Dataset search failed: <upstream message>``                                            |
| `connect`: `*` in roots                       | ``roots must name streams; omit roots to request all data.``                             |
| `update_event`: invalid content               | ``Update refused, nothing written: <problems>``                                          |
| `update_event`: empty update                  | ``Nothing to update.``                                                                   |
| `delete_events`: no target                    | ``Give ids or a sourceKeyPrefix.``                                                       |
| `ensure_streams`: item stream not in model    | ``Stream "X" of item "Y" is not in the data-model stream tree.``                         |

Pryv backend status codes propagate through these wrappers; the
underlying error body shape is
`{ "error": { "id": "<error-id>", "message": "…" } }`.

---

## How to extend (when adding a new tool)

1. Add the tool implementation under [`src/tools/`](src/tools/) — one
   file per tool, exporting both the Zod input schema (`<name>Input`)
   and the handler (`<name>Handler`).
2. Wire it in [`src/server.ts`](src/server.ts) via `server.tool(name,
   description, input, wrap(handler))`. The `wrap()` helper enforces
   that every thrown error goes through the scrubber before reaching
   the client.
3. If the tool writes to Pryv, route through
   [`lib/apiCall.ts`](src/lib/apiCall.ts)'s `apiPost` or `apiBatch` —
   both call `assertWriteAllowed` before the network round-trip.
4. Update the description with the itemDef-first directive **if the
   tool can create events**. Read existing `createEvent.ts` /
   `importBatch.ts` as the reference for wording.
5. Add tests under [`tests/`](tests/) — at minimum, type-check + lint
   pass + any new error message is tested for verbatim wording (we
   publish error wording in `llms-full.txt`).
6. Bump `version` in [`package.json`](package.json) — `src/server.ts`
   reads it at runtime (since v0.0.7), so there is nothing to bump in
   code.

---

## Remote transport (preview, plan 118)

`hds-mcp-http` serves the same tools (minus `connect`) over Streamable HTTP, for a deployment next to one HDS core
(a sidecar at `<core domain>/adapter/mcp/`, see below). Environment: `HDS_MCP_ISSUER` (the core's OAuth issuer), `HDS_MCP_PUBLIC_URL` (this
server's MCP URL, also the expected token audience), `HDS_MCP_INTROSPECT_CLIENT_ID` / `_SECRET` (a confidential
registry client with `--can-introspect`), `HDS_MCP_SERVICE_INFO` (`demo` default), `HDS_MCP_ALLOWED_ORIGINS`, `PORT`.

- **Credentials are per request.** [`auth/session.ts`](src/auth/session.ts) runs each HTTP request inside
  AsyncLocalStorage; a request never falls back to the stdio globals, and `connect` refuses inside one. Never add
  module-level state that holds a user's token or data: concurrent users share the process.
- **Spike token handling** (perki, 2026-11-02): the API is called with the same token at the `api_base` the core's
  introspection returns. The MCP spec forbids this passthrough; a separate credential through token exchange is a
  gate before production: `httpMain` refuses to start a production MCP without `HDS_MCP_TOKEN_EXCHANGE=true`.
- **One platform per MCP:** the platform comes from `HDS_MCP_SERVICE_INFO`; an `api_base` (or raw-mode access) on
  another platform is refused. On a production MCP the stdio write lock is open (`prodWritesEnabled`): the person's
  consent at sign-in (write scope per theme, raw mode's grant) is the write gate.
- **Token exchange** (`HDS_MCP_TOKEN_EXCHANGE=true`, off by default; core design PY1 R7): instead of introspecting,
  the MCP exchanges the connector's token at the core's `token_endpoint` (RFC 8693, `subject_token`, no scope
  narrowing) and calls the API with the derived token at the returned `api_base`. Needs the `hds-mcp` row flagged
  `--can-exchange` and the URN in the core's `oauth:grantTypesSupported`. `invalid_grant` / `invalid_target` → 401
  with `resource_metadata`; any other refusal (row not flagged, suspended, 421 `wrong_core`, never followed) → 500
  and a log line. Same 60 s cache, capped by `expires_in`.
- One MCP per core: issuers are per core, and clients follow only the first `authorization_servers` entry.
- **Sidecar behind the core** (Pryv adapter contract rule 5, perki 2026-11-04): with `HDS_MCP_PUBLIC_URL` =
  `https://<core domain>/adapter/mcp/mcp`, the adapter base is the MCP path's folder (`/adapter/mcp/`), and the
  manifest and status are served under it too (`/status` also stays at the root for the container healthcheck). The
  core must forward `<base>` and the root RFC 9728 path `/.well-known/oauth-protected-resource<MCP path>`: on demo
  through `infra/dev-deploy/dokku/create-sidecar.sh route … /adapter/mcp /.well-known/oauth-protected-resource/adapter/mcp`.
  A public URL of `/mcp` keeps everything at the root, as on a host of its own.
- **Discovery.** `GET <base>manifest.json` is the Pryv adapter manifest (`type: "mcp"`, `mcpEndpoint`,
  `authorizationServer`, connector `clients` from `HDS_MCP_CONNECTOR_CLIENTS="claude=…,chatgpt=…"`), public and
  CORS-open. A core lists this server's base URL in `/service/info` `adapters`; the account app reads the manifest to
  show the user their URL. Gated: nothing lists it until CIMD (perki).
- Tokens without `aud` are refused by default (since 0.7.2); `HDS_MCP_REQUIRE_AUDIENCE=false` accepts them, only for a
  core older than rc.70 or rows without `--audience`. A foreign `aud` is always refused.
- Outbound hardening (0.7.2): 10 s timeout on the AS metadata and introspection calls; the introspection endpoint
  (where the client secret goes) must be https on the issuer's host; `api_base` must be https.
- `HDS_MCP_SCOPES` (space-separated) is published as `scopes_supported`: the default a client asks for when it names
  no scope (Claude Code). Demo: `offline_access` + `hds/stream/<root>.read` on the 17 connector-row roots (perki,
  read-only default).
- Not offered over HTTP: `connect` (OAuth signs in) and `ensure_streams` (no grant carries `manage`).
- **Step-up** ([`src/http/stepUp.ts`](src/http/stepUp.ts)): before the transport, a `create_event` / `import_batch`
  whose target root the token cannot write gets 403 `insufficient_scope` with `scope` = current scopes plus
  `hds/stream/<root>.contribute` (plan 118 D-J3). Streams outside the model are left to the core.
- **Raw mode** ([`src/http/raw.ts`](src/http/raw.ts), `HDS_MCP_RAW=true`, at `<base>raw`; design and review:
  plan 118 RAW-MODE.md): the one stateful part. Sessions live in memory (a restart signs everyone out); the
  session id is the bearer of an app access, so: verify the accepted access, one-time hand-off, `expireAfter`,
  no host argument, never log sign-in or poll URLs, never return a token to the model. Raw `connect` /
  `connect_status` / `disconnect` are added through `buildServer({ extraTools })`.
- **Per-user addresses** ([`src/http/perUser.ts`](src/http/perUser.ts), `HDS_MCP_PER_USER_DOMAIN=api.datasafe.dev`,
  needs `HDS_MCP_TOKEN_EXCHANGE=true` and a core of rc.75 or later; plan 118 PER-USER-ADDRESS.md, core R10 + R11): on
  a per-user address the core sets `X-Adapter-Name` / `X-Adapter-Base` (stripping client copies; none on the region
  address). The resource is `X-Adapter-Base` + `mcp`, honoured only as `https://<name>.<domain>/adapter/mcp/`: its
  RFC 9728 metadata, 401 / 403 `resource_metadata` (`Vary: Host`), and `subject_token_resource` on the exchange (the
  core refuses a token issued for another address; the exchange cache is keyed by token + resource). A raw-mode
  session started there is pinned to that host and refuses (and deletes) an access of any other account than
  `X-Adapter-Name`. The manifest adds `baseTemplate` / `mcpEndpointTemplate` / `rawEndpointTemplate` with
  `{username}`. Which account may use the address is the core's check (R10: the signed-in account only, at sign-in and
  at the exchange); the region address keeps working as the legacy resource (R10 D4). Never test the Host here.

**Deploy.** CI-built image `ghcr.io/healthdatasafe/hds-mcp-js` (built on a `vX.Y.Z` tag by
`.github/workflows/build-image.yml`, deployed with `infra/dev-deploy/dokku/deploy-image.sh`), running
`node dist/httpMain.js` as uid 32767 on port **7450** (`PORT`, set in the image; map it with
`dokku ports:set <app> http:80:7450 https:443:7450`). `GET /status` answers `{ status, name, version }` without auth:
the Dokku startup healthcheck (`app.json`) and the deploy's version assertion read it. Environment: `HDS_MCP_ISSUER`,
`HDS_MCP_PUBLIC_URL`, `HDS_MCP_INTROSPECT_CLIENT_ID`, `HDS_MCP_INTROSPECT_CLIENT_SECRET`, `HDS_MCP_SERVICE_INFO`,
`HDS_MCP_ALLOWED_ORIGINS`, `PORT`, and for telemetry `HDS_OTEL_ENDPOINT` (the host collector's bare base URL,
`http://172.17.0.1:4318`; unset = telemetry off) and `HDS_OTEL_SERVICE_NAME` (`hds-<env>-mcp`; default built from
`HDS_ENV`, itself defaulting to `dev`). Telemetry goes only through `hds-observability-js`
([`src/http/observability.ts`](src/http/observability.ts)): aggregate counts per registered route, never a concrete
path; never add a vendor agent. Logs go to stderr only, nothing is written under `/app`.

## Source layout

```
src/
  index.ts             # stdio MCP entry
  server.ts            # tool registration (THIS is what clients see)
  auth/
    pryvAuth.ts        # Pryv poll-mode auth-request (no callback URL)
    session.ts         # in-memory apiEndpoint store
  tools/               # one file per tool (input schema + handler)
  dataModel/
    pack.ts            # fetches + caches model.datasafe.dev/pack.json
    eventTypes.ts      # item eventTypes, content schemas, validateEvent (ajv draft-04)
    codes.ts           # every terminology code an item carries (search by code)
    datasources.ts     # datasource defs + endpoint resolution via service-info assets
  lib/
    scrubber.ts        # MANDATORY redactor on every log/error path
    hostPolicy.ts      # demo-default; PROD_WRITES_ENABLED gate
    apiCall.ts         # apiGet / apiPost / apiBatch (enforces write gate)
tests/
  scrubber.test.ts     # pins the redactor contract
  hostPolicy.test.ts   # pins demo-default + prod-write gate
  eventTypes.test.ts   # eventType resolution, validation, refusal wording
  codes.test.ts        # code extraction (all pack shapes), code + locale search, endpoint resolution
  phase2.test.ts       # events.get params (clientData filters, paging), delete order, model paths
  session.test.ts      # per-request credential isolation
  http.test.ts         # HTTP transport: 401 + metadata, origin check, per-user token isolation end to end
```

`src/httpMain.ts` (HTTP entry) and `src/http/` (`app.ts`: express app; `introspection.ts`: token verifier) hold the
remote transport.

Auth flow is not unit-tested (network-dependent, browser-opening). It
is verified by live `curl` against `demo.datasafe.dev` + end-to-end
pilot runs.

---

## Cross-repo relationships

- **[hds-lib-js](https://github.com/healthdatasafe/hds-lib-js)** — the
  data-model + Pryv-wrapper library this MCP would consume in the v0.5
  auto-gen pass. Today the MCP duplicates the parts it needs (item
  search, event POST). When you add a new tool whose logic already
  lives in `hds-lib`, prefer wrapping over re-implementing.
  See [hds-lib-js/AGENTS.md](https://github.com/healthdatasafe/hds-lib-js/blob/main/AGENTS.md).
- **[site-agents](https://github.com/healthdatasafe/site-agents)** — owns
  `agents.datasafe.dev` (the agent-facing pages + the canonical
  `llms-full.txt` and `bootstrap.txt`). Tool-description wording in this
  repo is the source of truth; the docs cite it. When you change a
  description, also update `llms-full.txt` §4a and §7 in the same PR
  cycle. ([dev-site](https://github.com/healthdatasafe/dev-site) only
  keeps a teaser page that links out.)
- **[_macro](https://github.com/healthdatasafe/_macro)** — the workspace
  meta-repo whose issue tracker carries this project's planning and
  pilot notes (e.g. [#23](https://github.com/healthdatasafe/_macro/issues/23)).

---

## When in doubt

- For a Pryv question: read the Pryv API reference
  (<https://pryv.github.io/reference/>) — do not invent.
- For an HDS data-model question: the YAMLs at
  [healthdatasafe/data-model](https://github.com/healthdatasafe/data-model)
  are the source of truth; `pack.json` at `model.datasafe.dev` is the
  flattened agent-ready bundle.
- For the agent-facing tool surface, the canonical descriptions live
  in `src/server.ts`. The docs page mirrors them; if the two diverge,
  `server.ts` wins.
