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

## Tool catalogue (v0.1.0, tier=essential)

All seven tools are tagged `essential` and exposed by default. The
`extended` and `advanced` tiers are reserved for the v0.5 auto-gen pass.

| Tool                  | Purpose                                                                 | Notable behaviour                                                                                                                                                                                                                                                                                                                  |
|-----------------------|-------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **`connect`**         | OAuth (Pryv poll-mode) — opens browser, polls until accept              | Defaults: `host: "demo"`, `level: "contribute"`, scope **all streams** (`streamId: "*"` — per-stream scoping not yet supported). Other levels: `read`, `manage`. `enableWrites: true` (only with `host: "prod"`, only on the user's explicit ask) unlocks prod writes for the session. Returns `apiEndpoint` (held in-memory in [`auth/session.ts`](src/auth/session.ts)). |
| **`list_streams`**    | List the user's stream tree                                             | Reads always allowed on demo + prod.                                                                                                                                                                                                                                                                                               |
| **`get_events`**      | Query events, filtered by stream / type / time range                    | Reads always allowed on demo + prod.                                                                                                                                                                                                                                                                                               |
| **`search_items`**    | Search the HDS data-model catalogue                                     | Backed by [`dataModel/pack.ts`](src/dataModel/pack.ts) which fetches + caches `model.datasafe.dev/pack.json`. Scoring in [`tools/searchItems.ts`](src/tools/searchItems.ts) — exact-key match > exact-label match > substring matches.                                                                                              |
| **`get_item`**        | Get one HDS item's full definition by key                               | Pulls from the same cached pack. Returns localised label/description, `streamId`, `eventType` (or `variations.eventType.options[]`), `type`.                                                                                                                                                                                       |
| **`create_event`**    | Create one event                                                        | **Gated** on prod hosts via `assertWriteAllowed`. Description primes the agent to call `search_items` → `get_item` first.                                                                                                                                                                                                          |
| **`import_batch`**    | Create 1–500 events in one call                                         | Same gate. Same itemDef-first priming.                                                                                                                                                                                                                                                                                             |

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

## Error shapes (verbatim, as of v0.1.0)

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
  lib/
    scrubber.ts        # MANDATORY redactor on every log/error path
    hostPolicy.ts      # demo-default; PROD_WRITES_ENABLED gate
    apiCall.ts         # apiGet / apiPost / apiBatch (enforces write gate)
tests/
  scrubber.test.ts     # pins the redactor contract
  hostPolicy.test.ts   # pins demo-default + prod-write gate
```

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
