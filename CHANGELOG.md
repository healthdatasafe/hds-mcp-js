# Changelog

## [Unreleased]

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
