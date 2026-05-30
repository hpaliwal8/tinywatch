# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 1.0.0

First stable release.

### Client

- `init` / `track` / `identify` / `use` / `shutdown` — named exports; a real
  consumer's critical path (`init` + `track`) tree-shakes to ~830 B gzipped.
- Cookieless first-party anonymous id (localStorage) and session id
  (sessionStorage, 30-min inactivity window) with in-memory fallbacks when
  storage is blocked.
- Lazy-loaded transport: batching with interval + `beforeunload` /
  `visibilitychange` flushing via `sendBeacon`. Events fired before the chunk
  loads are buffered and drained, with a pre-load beacon safety net.
- Autocapture (lazy, opt-out via `autocapture: false`): `$pageview` (incl. SPA
  history patching), `$click` on `[data-tw-track]`, `$scroll` depth milestones,
  and `$section` dwell with tab-visibility pausing.
- `shutdown()` fully reverses `init()` — clears timers, removes every listener,
  restores patched history, and resets state for clean re-init.

### Server

- `createHandler` — a portable Web-standard `(Request) => Promise<Response>`
  ingestion endpoint. Runs on Node, Bun, Deno, Cloudflare Workers, and edge.
- `createQueries` — visitors, sessions, section dwell, and top countries
  (default last-7-days range).
- Hardening: per-IP rate limiting, CORS allowlist (echoes an allowed `Origin`),
  batch-size cap, request body-size guard, client-`ts` clamping, `sessionId`
  validation, and bounded string/props sizes. Storage failures return a
  CORS-preserving `503`.
- Geo (IP / country / city) extracted from Cloudflare and Vercel headers.

### Adapters

Pluggable `DbAdapter` contract with four implementations, behaviorally identical
across backends:

- **SQLite** (better-sqlite3) — reference adapter.
- **Turso** (@libsql/client).
- **Cloudflare D1**.
- **Postgres** (node-postgres) — JSONB props, chunked multi-row inserts under the
  parameter ceiling.

### Plugins

- Subpath-exported plugin system (`tinywatch/plugins/*`) registered via `use()`,
  with teardown support and an `onFlushError` / `reenqueue` hook.
- `outbound` — track clicks to external sites.
- `retry` — re-deliver failed flushes with exponential backoff and a per-event
  attempt cap (re-delivered events keep their ids and dedup server-side).

### Tooling

- ESM + CJS builds with correct types across node10 / node16 / bundler
  resolution (verified by `attw`).
- Size budgets enforced via `size-limit`.
- CI runs typecheck, tests, build, size, and `attw`, plus an integration suite
  against a real Postgres service container.
