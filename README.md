# hds-mcp

> **Status: v0 — read-only, demo-only.** This release lets your AI agent connect
> to a throwaway demo HDS account and read your data. Write tools (importing
> events, creating notes) are in v0.2.

Connect [Health Data Safe](https://datasafe.dev) to your AI agent (Claude
Desktop, ChatGPT desktop, Cursor, …) so it can sign you in, read your data,
and help you make sense of it. No coding required.

---

## What you'll be able to do (v0)

Ask your agent things like:

> *"Connect me to a demo HDS account and tell me what data I already have there."*

> *"List all streams in my account and group them by topic."*

> *"Get the last 30 days of events from the body stream and summarize them."*

Bigger flows (uploading a folder of charts, importing a CSV, OCR-ing scanned
paper) need **write** tools that are not in v0 — see [Roadmap](#roadmap).

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
      "args": ["-y", "hds-mcp"]
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
verification) or sign in if you already have a demo account.

When the browser shows "you're signed in", come back to Claude Desktop.
Claude will continue automatically and confirm your connection.

That's it. The connection lasts until you quit Claude Desktop.

---

## What the tools do

The MCP exposes three tools to your agent. **You don't call them directly —**
you just ask your agent in plain language. The agent picks the right tool.

| Tool | What it does | Plain-language prompt |
|---|---|---|
| `connect` | Sign you into demo HDS via your browser | *"Sign me in to demo HDS."* |
| `list_streams` | Show the tree of data containers in your account | *"What streams do I have?"* |
| `get_events` | Read events (data points) — filterable by stream / type / time | *"Get my last week of body events."* |

---

## Why "demo only" for now

`hds-mcp` v0 defaults to `demo.datasafe.dev` — a throwaway sandbox. Tokens
there are not secret and a mistake costs nothing. Once we've watched real
users go through the connect + read flow without surprises, we'll open the
production path in a follow-up release.

You **can** read from production today by explicitly passing
`host: "prod"` to the connect tool. Write tools targeting prod will refuse
in v0 even if you pass `host: "prod"`.

---

## Privacy

- The MCP runs on **your** computer; nothing routes through us.
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

- **v0.2** — write tools (`create_event`, `import_batch`), event-type search
  (`search_event_types` + `get_event_type_spec`), end-to-end fertility-charts
  pilot.
- **v0.3** — full auto-generated tool surface from `hds-lib-js` +
  `hds-forms-js`, tiered (essential / extended / advanced).
- **v1** — production-write gate flipped on; published to the MCP registry.
- **Later** — hosted MCP endpoint; in-repo Claude Code app-dev scaffold
  (see [tbouchard-cycle-intelligence](https://github.com/healthdatasafe/tbouchard-cycle-intelligence) `perki` branch as a working reference of that pattern).

---

## For developers

```bash
npm install
npm test           # runs the token-scrubber unit test
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
  lib/
    scrubber.ts        # centralized token redactor (mandatory on every log/error)
    hostPolicy.ts      # demo-default; PROD_WRITES_ENABLED gate
    apiCall.ts         # thin wrapper around Pryv REST API
tests/
  scrubber.test.ts     # pins the redactor contract
```

License: BSD-3-Clause.
