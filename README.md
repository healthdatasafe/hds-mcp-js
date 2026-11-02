# hds-mcp

> **Status: v0.2.0 — production access when you're ready.** One-line
> install (`npx -y github:healthdatasafe/hds-mcp-js`), demo sandbox by
> default, and now a per-session opt-in for writing to your real
> production account — you ask for it explicitly, the agent passes
> `enableWrites: true`, you confirm on the consent screen. See
> [Demo by default — production when you're ready](#demo-by-default--production-when-youre-ready).

Connect [Health Data Safe](https://datasafe.dev) to your AI agent (Claude
Desktop, ChatGPT desktop, Cursor, …) so it can sign you in, read your data,
and help you make sense of it. No coding required.

---

## What you'll be able to do

Ask your agent things like:

> *"Connect me to a demo HDS account and tell me what data I already have there."*

> *"List all streams in my account and group them by topic."*

> *"Get the last 30 days of events from the body stream and summarize them."*

> *"Log my weight as 72 kg now."*

> *"Here's a CSV of my fertility chart — import every row as an event."*

For the bigger "read a folder of Excel + scanned paper and import all of it"
flow you still need your agent client to provide file I/O + OCR (filesystem
MCP + vision). See [Roadmap](#roadmap).

---

## What you need

1. A computer (macOS or Windows).
2. **Claude Desktop** installed → <https://claude.ai/download>.
3. **Node.js 20 or newer** → <https://nodejs.org> (any LTS works; pick the green button).
4. A browser (any modern one) for the sign-in step.

> **For the bigger "process a folder of documents" scenario** you will also
> need filesystem access from inside your agent. Claude Desktop ships with a
> built-in filesystem tool but it's off by default — check the Anthropic
> docs for your agent client to enable it. (No copy-paste setup from us yet;
> see Roadmap.)

---

## Install — 3 steps

### 1. Open Claude Desktop's config

In Claude Desktop:
- **macOS:** menu bar → Claude → Settings → Developer → Edit Config.
- **Windows:** ☰ menu → Settings → Developer → Edit Config.

A JSON file opens. If it's empty, paste this:

```json
{
  "mcpServers": {
    "hds": {
      "command": "npx",
      "args": ["-y", "github:healthdatasafe/hds-mcp-js"]
    }
  }
}
```

If you already have `mcpServers` set up, add the `"hds": { ... }` entry
inside it.

### 2. Save and quit Claude Desktop completely

On macOS use ⌘Q. The MCP only loads on a fresh launch.

### 3. Re-open Claude Desktop

You should see a small "🔌 1" indicator (or similar) at the bottom of the
chat input. That means the MCP is connected.

---

## Sign in (first use)

Open a new chat in Claude Desktop and type:

> *"Use the hds connect tool to sign me in."*

Claude will ask permission to call the `connect` tool. Approve it. Your
browser opens to **demo.datasafe.dev**. Sign up (it's instant, no email
verification) or sign in if you already have a demo account. A consent
screen then shows what's requested — **all your HDS data, with
read+write ("contribute") access** — click Accept. Demo accounts are
throwaway sandboxes, so this is safe to approve.

When the browser shows "you're signed in", come back to Claude Desktop.
Claude will continue automatically and confirm your connection.

That's it. The connection lasts until you quit Claude Desktop.

---

## What the tools do

The MCP exposes fourteen tools to your agent. **You don't call them directly —**
you just ask your agent in plain language. The agent picks the right tool.

| Tool | What it does | Plain-language prompt |
|---|---|---|
| `connect` | Sign you into demo HDS via your browser | *"Sign me in to demo HDS."* |
| `list_streams` | Show the tree of data containers in your account | *"What streams do I have?"* |
| `get_events` | Read events (data points) — filterable by stream / type / time | *"Get my last week of body events."* |
| `search_items` | Search the HDS data-model for the right item to log | *"What HDS item should I use for basal body temperature?"* |
| `get_item` | Get the full definition of one HDS item by key | *"Show me the spec for body-weight."* |
| `get_event_type` | Show what one event type accepts (its content schema) | *"What does a coded lab result look like?"* |
| `list_model_streams` | Browse the data model's categories and their items | *"What can HDS store about fertility?"* |
| `list_datasources` | List the coded lists HDS offers (conditions, medications, …) | *"Which coded lists does HDS have?"* |
| `search_dataset` | Find a coded entry (diagnosis, drug, treatment) to record | *"Find the code for endometriosis."* |
| `create_event` | Write a single event into a stream | *"Log my weight as 72 kg right now."* |
| `import_batch` | Write up to 500 events in one call | *"Import every row of this CSV as a temperature event."* |
| `ensure_streams` | Create the data containers an item needs before writing | *(the agent does this itself before an import)* |
| `update_event` | Fix one event in place | *"That weight should be 71.9, not 71.5."* |
| `delete_events` | Remove events, or everything one import wrote; shows the list first | *"Remove everything the health-files import wrote."* |

---

## Demo by default — production when you're ready

`hds-mcp` defaults to `demo.datasafe.dev` — a throwaway sandbox. Tokens
there are not secret and a mistake costs nothing. Learn the ropes there.

When you're ready to work on your **real** account:

- **Reading** production works by just asking — the agent passes
  `host: "prod"` to the connect tool.
- **Writing** to production needs you to say so explicitly — e.g. *"sign
  me in to production and enable writing"*. The agent then connects with
  `enableWrites: true`, and you confirm the access on the sign-in consent
  screen. Without that explicit ask, write tools refuse on production.

The write unlock lasts for the session (until you quit the client) — the
next session starts back in the safe state.

---

## Privacy

- The MCP runs on **your** computer; nothing routes through us.
- **Your AI agent's provider sees what the agent reads.** Every record,
  scan or value the agent reads is sent to the company that runs the agent;
  the MCP cannot change that. For medical records, a provider that does not
  train on your data, or a model on your own computer, is the safer choice.
  The agent is told to say this before reading anything.
- `search_dataset` sends its search text (for example a condition or drug
  name) to the HDS datasets service of the platform you use.
- Your sign-in token is held in memory only and is gone when Claude Desktop
  quits.
- The MCP scrubs your token from any log line or error message before
  writing it. There's a unit test that pins this.

---

## Troubleshooting

**Claude says "no tool named connect" or doesn't see the MCP.**
- Did you fully quit Claude Desktop (⌘Q on macOS) before reopening it?
- Is `node --version` ≥ 20? `npx` needs Node.

**The browser tab never opens during connect.**
- Check Claude Desktop's tool-permission popup didn't get dismissed.
- Your default browser must be set to a real browser (not a PDF reader, etc.).

**"auth timed out — please re-run hds.connect"**
- You took longer than 5 minutes to complete the sign-in. Re-run the tool.

**Anything else** — please [open an issue](https://github.com/healthdatasafe/hds-mcp-js/issues).

---

## Roadmap

- **v0.4.0 (current)**: imports done safely: `connect` can ask for only
  the kinds of data an import needs, under the import's own name; read
  back, fix (`update_event`) or remove (`delete_events`, with a preview)
  everything an import wrote.
- **v0.3.0**: data model and datasets read tools:
  `search_items` finds items by LOINC / SNOMED-CT code and by French
  label; new `get_event_type`, `list_model_streams`, `list_datasources`,
  `search_dataset`.
- **v0.2.0**: the write tools take `description` and
  `clientData`, check content against the data model before writing, and
  return the created ids in order; `get_item` shows content schemas;
  `search_items` no longer crashes on items with a unit choice.
- **v0.1.0** — production writes become a per-session user
  opt-in: `connect({ host: "prod", enableWrites: true })`, only when the
  user explicitly asks. Replaces the planned global gate-flip.
- **v0.0.7** — installable with one line via
  `npx -y github:healthdatasafe/hds-mcp-js`: ships compiled JS (`dist/`,
  built on install) so `npx` works without the npm registry.
- **v0.0.6** — `search_items` + `get_item` backed by the published
  HDS data-model (`pack.json` at `model.datasafe.dev`); pilot-tightened
  auth (read+write by default; fixed `info.access` POST URL + snake_case
  `poll_rate_ms`).
- **next** — end-to-end fertility-charts pilot, friction notes published.
- **later (v0.5)** — full auto-generated tool surface from `hds-lib-js` +
  `hds-forms-js`, tiered (essential / extended / advanced).
- **v1** — published to the MCP registry. (The production-write gate-flip
  originally slated here shipped early, as the v0.1.0 per-session opt-in.)
- **after v1** — hosted MCP endpoint; in-repo Claude Code app-dev scaffold.

---

## For developers

```bash
npm install
npm test           # scrubber, host policy, eventType validation
npm run lint
```

Source layout:

```
src/
  index.ts             # entry: starts stdio MCP server
  server.ts            # tool registration
  auth/
    pryvAuth.ts        # Pryv auth-request poll flow (no callback needed)
    session.ts         # in-memory token store
  tools/
    connect.ts
    listStreams.ts
    getEvents.ts
    createEvent.ts
    importBatch.ts
    searchItems.ts
    getItem.ts
  dataModel/
    pack.ts            # fetches + caches model.datasafe.dev/pack.json
    eventTypes.ts      # item eventTypes, content schemas, validation before writing
    codes.ts           # terminology codes per item (search by code)
    datasources.ts     # dataset endpoints via service-info assets
  lib/
    scrubber.ts        # centralized token redactor (mandatory on every log/error)
    hostPolicy.ts      # demo-default; prod-write gate (session opt-in or env override)
    apiCall.ts         # apiGet / apiPost / apiBatch; enforces the write gate
tests/
  scrubber.test.ts     # pins the redactor contract
  hostPolicy.test.ts   # pins demo-default + prod-write gate
  eventTypes.test.ts   # eventType resolution + content validation + refusal wording
  codes.test.ts        # code extraction, code + locale search
  phase2.test.ts       # read-back filters, delete order, model paths
```

License: BSD-3-Clause.
