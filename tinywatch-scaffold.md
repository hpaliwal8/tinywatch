# tinywatch — development scaffold

Drop these files into an empty folder, then:

```bash
npm install
npm run dev      # tsup --watch, rebuilds on save
# in another terminal:
npm run typecheck
npm test
npm run size     # check the byte budgets
```

## File tree

```
tinywatch/
├─ package.json                  ← from the previous artifact
├─ tsconfig.json
├─ tsup.config.ts
├─ .gitignore
├─ README.md
├─ src/
│  ├─ types/
│  │  └─ index.ts                ← the shared contract (the spine)
│  ├─ client/
│  │  ├─ index.ts                ← init / track / identify / use
│  │  ├─ ids.ts                  ← anon id + session id
│  │  ├─ transport.ts            ← batching + sendBeacon flush
│  │  ├─ autocapture.ts          ← clicks / pageviews / scroll (lazy-loaded)
│  │  └─ sections.ts             ← IntersectionObserver dwell
│  ├─ server/
│  │  ├─ index.ts                ← createHandler / createQueries
│  │  ├─ geo.ts                  ← IP / country / city from platform headers
│  │  ├─ rate-limit.ts           ← in-memory limiter (swap for prod)
│  │  └─ adapters/
│  │     ├─ sqlite.ts            ← reference adapter (works today)
│  │     ├─ turso.ts             ← stub
│  │     ├─ d1.ts                ← stub
│  │     └─ postgres.ts          ← stub
│  └─ cli.ts                     ← `npx tinywatch migrate`
├─ examples/
│  └─ tinywatch.config.mjs       ← what your *users* write
└─ test/
   └─ client.test.ts            ← smoke test so `npm test` passes
```

> `package.json` lives in the separate artifact — paste it in unchanged.

---

## `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "noEmit": true,
    "types": ["node", "@cloudflare/workers-types"]
  },
  "include": ["src", "test"],
  "exclude": ["dist", "node_modules"]
}
```

> One tsconfig with both `DOM` and `node` libs keeps the scaffold simple. If client/server type bleed bothers you later, split into `tsconfig.client.json` (DOM only) and `tsconfig.server.json` (node only) and reference both from a root config.

---

## `tsup.config.ts`

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/client/index.ts",
    server: "src/server/index.ts",
    types: "src/types/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm", "cjs"],
  dts: true,          // emits .d.ts (ESM) and .d.cts (CJS)
  clean: true,
  treeshake: true,
  splitting: true,    // needed so the lazy autocapture import becomes its own chunk
  sourcemap: true,
  target: "es2020",
  outDir: "dist",
});
```

> `splitting: true` matters here: it lets the dynamic `import("./autocapture")` in the client become a separate chunk instead of being inlined into the core, which is what keeps the synchronous bundle small.

---

## `.gitignore`

```
node_modules
dist
*.db
*.db-journal
.DS_Store
```

---

## `src/types/index.ts` — the contract

```ts
// Runtime-free type contracts shared by client + server.
// Consumers import these via `tinywatch/types`. Prefer `import type`.

/** A single event as it travels over the wire (client → server). */
export interface TinywatchEvent {
  /** Event name. Reserved: "$pageview", "$click", "$scroll", "$section". */
  name: string;
  /** Stable first-party anonymous id (cookieless). */
  anonymousId: string;
  /** Known user id, set after identify(). */
  userId?: string;
  /** Session id, rotated after inactivity. */
  sessionId: string;
  /** URL path at event time. */
  path: string;
  /** Arbitrary event properties. */
  props?: Record<string, unknown>;
  /** Client timestamp (ms since epoch). */
  ts: number;
}

/** Batch envelope POSTed to the ingestion handler. */
export interface EventBatch {
  events: TinywatchEvent[];
  /** SDK version, for spotting schema drift. */
  v: string;
}

/** Configuration passed to the client init(). */
export interface ClientConfig {
  /** Ingestion endpoint where your createHandler() is mounted. */
  endpoint: string;
  /** Click/pageview/scroll/section autocapture. Default true. */
  autocapture?: boolean;
  /** Flush interval (ms). Default 5000. */
  flushInterval?: number;
  /** Buffered events before an eager flush. Default 30. */
  batchSize?: number;
  /** Attribute used for click autocapture. Default "data-tw-track". */
  trackAttribute?: string;
  /** Attribute used for section dwell. Default "data-tw-section". */
  sectionAttribute?: string;
  /** Keep the anon id in memory only (no localStorage). Default false. */
  noPersist?: boolean;
}

/** A client plugin registered via use(). */
export interface Plugin {
  name: string;
  setup(ctx: PluginContext): void;
}

export interface PluginContext {
  track: (name: string, props?: Record<string, unknown>) => void;
  config: Required<ClientConfig>;
}

/** Geo/IP info extracted server-side from platform headers. */
export interface RequestContext {
  ip?: string;
  country?: string;
  city?: string;
  userAgent?: string;
}

/** Normalized row the adapter persists. */
export interface StoredEvent extends TinywatchEvent {
  id: string;
  country?: string;
  city?: string;
  userAgent?: string;
  receivedAt: number;
}

export interface TimeRange {
  from: number;
  to: number;
}

export interface SectionDwell {
  section: string;
  totalMs: number;
  views: number;
}

export interface CountryCount {
  country: string;
  visitors: number;
}

/** Pluggable database adapter contract — implement one per backend. */
export interface DbAdapter {
  /** Create tables/indexes if absent. Called by `npx tinywatch migrate`. */
  migrate(): Promise<void>;
  /** Persist a batch of events. */
  insertEvents(events: StoredEvent[]): Promise<void>;
  getVisitors(range: TimeRange): Promise<number>;
  getSessions(range: TimeRange): Promise<number>;
  getSectionDwell(range: TimeRange): Promise<SectionDwell[]>;
  getTopCountries(range: TimeRange): Promise<CountryCount[]>;
  /** Delete raw events older than `before` (ms epoch). For the rollup helper. */
  pruneBefore?(before: number): Promise<number>;
}

export interface HandlerConfig {
  adapter: DbAdapter;
  /** Requests per IP per minute. Default 120. */
  rateLimit?: number;
  /** Allowed CORS origin(s). Default "*". */
  cors?: string | string[];
}

export interface QueriesConfig {
  adapter: DbAdapter;
}
```

---

## `src/client/ids.ts`

```ts
import type { ClientConfig } from "../types";

const ANON_KEY = "tw_anon";
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 min

let memAnon: string | undefined;
let session: { id: string; last: number } | undefined;

function rid(): string {
  return crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getAnonymousId(persist: boolean): string {
  if (!persist) return (memAnon ??= rid());
  try {
    let id = localStorage.getItem(ANON_KEY);
    if (!id) {
      id = rid();
      localStorage.setItem(ANON_KEY, id);
    }
    return id;
  } catch {
    // localStorage blocked (private mode, etc.) — fall back to memory.
    return (memAnon ??= rid());
  }
}

export function getSessionId(): string {
  const now = Date.now();
  if (session && now - session.last < SESSION_TIMEOUT) {
    session.last = now;
    return session.id;
  }
  session = { id: rid(), last: now };
  return session.id;
}

export type { ClientConfig };
```

---

## `src/client/transport.ts`

```ts
import type { EventBatch, TinywatchEvent } from "../types";

const VERSION = "0.1.0";

export class Transport {
  private buf: TinywatchEvent[] = [];

  constructor(
    private endpoint: string,
    private flushInterval: number,
    private batchSize: number,
  ) {}

  start(): void {
    setInterval(() => this.flush(), this.flushInterval);
    addEventListener("beforeunload", () => this.flush(true));
    // visibilitychange is more reliable than beforeunload on mobile.
    addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.flush(true);
    });
  }

  enqueue(event: TinywatchEvent): void {
    this.buf.push(event);
    if (this.buf.length >= this.batchSize) this.flush();
  }

  flush(useBeacon = false): void {
    if (this.buf.length === 0) return;
    const batch: EventBatch = { events: this.buf, v: VERSION };
    this.buf = [];
    const body = JSON.stringify(batch);

    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(this.endpoint, body);
      return;
    }
    fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {
      // Best-effort. TODO: optional retry/backoff as a plugin, not in core.
    });
  }
}
```

---

## `src/client/index.ts`

```ts
import type { ClientConfig, Plugin, PluginContext, TinywatchEvent } from "../types";
import { getAnonymousId, getSessionId } from "./ids";
import { Transport } from "./transport";

const DEFAULTS = {
  autocapture: true,
  flushInterval: 5000,
  batchSize: 30,
  trackAttribute: "data-tw-track",
  sectionAttribute: "data-tw-section",
  noPersist: false,
} satisfies Omit<Required<ClientConfig>, "endpoint">;

let cfg: Required<ClientConfig> | undefined;
let transport: Transport | undefined;
let knownUserId: string | undefined;

export function init(config: ClientConfig): void {
  if (cfg) return; // idempotent
  cfg = { ...DEFAULTS, ...config };
  transport = new Transport(cfg.endpoint, cfg.flushInterval, cfg.batchSize);
  transport.start();

  // Fire the first pageview on the critical path...
  track("$pageview");

  // ...then load autocapture lazily so it never blocks first byte and stays
  // out of the synchronous core bundle (this is what keeps the core tiny).
  if (cfg.autocapture) {
    void import("./autocapture").then(({ startAutocapture }) => {
      startAutocapture(cfg!, track);
    });
  }
}

export function track(name: string, props?: Record<string, unknown>): void {
  if (!cfg || !transport) return; // not initialized — no-op
  const event: TinywatchEvent = {
    name,
    anonymousId: getAnonymousId(!cfg.noPersist),
    userId: knownUserId,
    sessionId: getSessionId(),
    path: location.pathname,
    props,
    ts: Date.now(),
  };
  transport.enqueue(event);
}

export function identify(userId: string): void {
  knownUserId = userId;
}

export function use(plugin: Plugin): void {
  if (!cfg) throw new Error("tinywatch: call init() before use()");
  const ctx: PluginContext = { track, config: cfg };
  plugin.setup(ctx);
}

// Named exports only (init / track / identify / use / shutdown) — a `tw`
// namespace object was dropped because it defeats tree-shaking of unused members.

export type { ClientConfig, Plugin, PluginContext } from "../types";
```

---

## `src/client/autocapture.ts`

```ts
import type { ClientConfig } from "../types";

type Track = (name: string, props?: Record<string, unknown>) => void;

export function startAutocapture(cfg: Required<ClientConfig>, track: Track): void {
  // Clicks via event delegation on [data-tw-track].
  document.addEventListener("click", (e) => {
    const el = (e.target as Element | null)?.closest(`[${cfg.trackAttribute}]`);
    if (!el) return;
    const label = el.getAttribute(cfg.trackAttribute);
    track(label ? label : "$click", {
      text: (el.textContent ?? "").trim().slice(0, 120),
      tag: el.tagName.toLowerCase(),
    });
  });

  // SPA pageviews: patch History + listen for popstate.
  patchHistory(() => track("$pageview"));
  addEventListener("popstate", () => track("$pageview"));

  // Scroll depth milestones.
  trackScrollDepth(track);

  // Section dwell (loaded with autocapture so it's also off the critical path).
  void import("./sections").then(({ startSectionObserver }) => {
    startSectionObserver(cfg, track);
  });
}

function patchHistory(onChange: () => void): void {
  for (const m of ["pushState", "replaceState"] as const) {
    const orig = history[m];
    history[m] = function (this: History, ...args: Parameters<History["pushState"]>) {
      const r = orig.apply(this, args);
      onChange();
      return r;
    };
  }
}

function trackScrollDepth(track: Track): void {
  const seen = new Set<number>();
  addEventListener(
    "scroll",
    () => {
      const h = document.documentElement;
      const pct = Math.round(((h.scrollTop + h.clientHeight) / h.scrollHeight) * 100);
      for (const mark of [25, 50, 75, 100]) {
        if (pct >= mark && !seen.has(mark)) {
          seen.add(mark);
          track("$scroll", { depth: mark });
        }
      }
    },
    { passive: true },
  );
}
```

---

## `src/client/sections.ts`

```ts
import type { ClientConfig } from "../types";

type Track = (name: string, props?: Record<string, unknown>) => void;

export function startSectionObserver(cfg: Required<ClientConfig>, track: Track): void {
  if (typeof IntersectionObserver === "undefined") return;
  const enteredAt = new Map<Element, number>();

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const el = entry.target;
        const name = el.getAttribute(cfg.sectionAttribute) ?? "section";
        if (entry.isIntersecting) {
          enteredAt.set(el, performance.now());
        } else {
          const start = enteredAt.get(el);
          if (start != null) {
            enteredAt.delete(el);
            track("$section", { section: name, dwellMs: Math.round(performance.now() - start) });
          }
        }
      }
    },
    { threshold: 0.5 },
  );

  for (const el of document.querySelectorAll(`[${cfg.sectionAttribute}]`)) io.observe(el);
}
```

---

## `src/server/geo.ts`

```ts
import type { RequestContext } from "../types";

/** Pull IP / country / city from Cloudflare and Vercel headers. */
export function extractContext(req: Request): RequestContext {
  const h = req.headers;
  const ip =
    h.get("cf-connecting-ip") ??
    h.get("x-real-ip") ??
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    undefined;

  const country = h.get("cf-ipcountry") ?? h.get("x-vercel-ip-country") ?? undefined;
  const rawCity = h.get("x-vercel-ip-city") ?? undefined;

  return {
    ip,
    country: country ?? undefined,
    city: rawCity ? decodeURIComponent(rawCity) : undefined,
    userAgent: h.get("user-agent") ?? undefined,
  };
}
```

---

## `src/server/rate-limit.ts`

```ts
const hits = new Map<string, { count: number; reset: number }>();

/** Fixed-window limiter. Returns true if the request should be rejected. */
export function rateLimited(ip: string, perMinute: number): boolean {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.reset) {
    hits.set(ip, { count: 1, reset: now + 60_000 });
    return false;
  }
  rec.count += 1;
  return rec.count > perMinute;
}

// ⚠️ In-memory and per-instance: resets on cold starts and isn't shared across
// serverless instances. Fine for single-node and dev. For production at the
// edge, back this with a Durable Object / KV / Redis and inject your own limiter.
```

---

## `src/server/index.ts`

```ts
import type {
  EventBatch,
  HandlerConfig,
  QueriesConfig,
  StoredEvent,
  TimeRange,
} from "../types";
import { extractContext } from "./geo";
import { rateLimited } from "./rate-limit";

/** Returns a portable Web-standard (Request → Response) ingestion handler. */
export function createHandler(config: HandlerConfig) {
  const { adapter, rateLimit = 120, cors = "*" } = config;
  const corsOrigin = Array.isArray(cors) ? cors.join(",") : cors;

  const baseHeaders = {
    "access-control-allow-origin": corsOrigin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };

  return async function handler(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: baseHeaders });
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405, baseHeaders);

    const ctx = extractContext(req);
    if (ctx.ip && rateLimited(ctx.ip, rateLimit)) {
      return json({ error: "rate limited" }, 429, baseHeaders);
    }

    let batch: EventBatch;
    try {
      batch = (await req.json()) as EventBatch;
    } catch {
      return json({ error: "invalid json" }, 400, baseHeaders);
    }
    if (!batch?.events?.length) return json({ ok: true, stored: 0 }, 200, baseHeaders);

    const now = Date.now();
    const rows: StoredEvent[] = [];
    for (const e of batch.events) {
      // Minimal schema validation. Tighten as needed.
      if (typeof e?.name !== "string" || typeof e?.anonymousId !== "string") continue;
      rows.push({
        ...e,
        id: crypto.randomUUID(),
        country: ctx.country,
        city: ctx.city,
        userAgent: ctx.userAgent,
        receivedAt: now,
      });
    }
    await adapter.insertEvents(rows);
    return json({ ok: true, stored: rows.length }, 200, baseHeaders);
  };
}

/** Returns the stats API backed by your adapter. Defaults to the last 7 days. */
export function createQueries(config: QueriesConfig) {
  const { adapter } = config;
  const range = (r?: Partial<TimeRange>): TimeRange => ({
    from: r?.from ?? Date.now() - 7 * 864e5,
    to: r?.to ?? Date.now(),
  });
  return {
    getVisitors: (r?: Partial<TimeRange>) => adapter.getVisitors(range(r)),
    getSessions: (r?: Partial<TimeRange>) => adapter.getSessions(range(r)),
    getSectionDwell: (r?: Partial<TimeRange>) => adapter.getSectionDwell(range(r)),
    getTopCountries: (r?: Partial<TimeRange>) => adapter.getTopCountries(range(r)),
  };
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json" },
  });
}

export { sqliteAdapter } from "./adapters/sqlite";
export { tursoAdapter } from "./adapters/turso";
export { d1Adapter } from "./adapters/d1";
export { postgresAdapter } from "./adapters/postgres";
export type { DbAdapter } from "../types";
```

---

## `src/server/adapters/sqlite.ts` — reference adapter (works today)

```ts
import type {
  CountryCount,
  DbAdapter,
  SectionDwell,
  StoredEvent,
  TimeRange,
} from "../../types";
import type Database from "better-sqlite3";

/** Pass a better-sqlite3 Database instance you already own. */
export function sqliteAdapter(db: Database.Database): DbAdapter {
  return {
    async migrate() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tw_events (
          id           TEXT PRIMARY KEY,
          name         TEXT NOT NULL,
          anonymous_id TEXT NOT NULL,
          user_id      TEXT,
          session_id   TEXT NOT NULL,
          path         TEXT,
          props        TEXT,
          country      TEXT,
          city         TEXT,
          user_agent   TEXT,
          ts           INTEGER NOT NULL,
          received_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tw_events_ts      ON tw_events(ts);
        CREATE INDEX IF NOT EXISTS idx_tw_events_name    ON tw_events(name);
        CREATE INDEX IF NOT EXISTS idx_tw_events_session ON tw_events(session_id);
      `);
    },

    async insertEvents(events: StoredEvent[]) {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO tw_events
          (id, name, anonymous_id, user_id, session_id, path, props, country, city, user_agent, ts, received_at)
        VALUES
          (@id, @name, @anonymousId, @userId, @sessionId, @path, @props, @country, @city, @userAgent, @ts, @receivedAt)
      `);
      const tx = db.transaction((rows: StoredEvent[]) => {
        for (const e of rows) {
          stmt.run({
            id: e.id,
            name: e.name,
            anonymousId: e.anonymousId,
            userId: e.userId ?? null,
            sessionId: e.sessionId,
            path: e.path ?? null,
            props: e.props ? JSON.stringify(e.props) : null,
            country: e.country ?? null,
            city: e.city ?? null,
            userAgent: e.userAgent ?? null,
            ts: e.ts,
            receivedAt: e.receivedAt,
          });
        }
      });
      tx(events);
    },

    async getVisitors({ from, to }: TimeRange) {
      const row = db
        .prepare(`SELECT COUNT(DISTINCT anonymous_id) AS n FROM tw_events WHERE ts BETWEEN ? AND ?`)
        .get(from, to) as { n: number };
      return row.n;
    },

    async getSessions({ from, to }: TimeRange) {
      const row = db
        .prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM tw_events WHERE ts BETWEEN ? AND ?`)
        .get(from, to) as { n: number };
      return row.n;
    },

    async getSectionDwell({ from, to }: TimeRange): Promise<SectionDwell[]> {
      return db
        .prepare(`
          SELECT json_extract(props, '$.section') AS section,
                 SUM(json_extract(props, '$.dwellMs')) AS totalMs,
                 COUNT(*) AS views
          FROM tw_events
          WHERE name = '$section' AND ts BETWEEN ? AND ?
          GROUP BY section
          ORDER BY totalMs DESC
        `)
        .all(from, to) as SectionDwell[];
    },

    async getTopCountries({ from, to }: TimeRange): Promise<CountryCount[]> {
      return db
        .prepare(`
          SELECT country, COUNT(DISTINCT anonymous_id) AS visitors
          FROM tw_events
          WHERE country IS NOT NULL AND ts BETWEEN ? AND ?
          GROUP BY country
          ORDER BY visitors DESC
          LIMIT 20
        `)
        .all(from, to) as CountryCount[];
    },

    async pruneBefore(before: number) {
      return db.prepare(`DELETE FROM tw_events WHERE ts < ?`).run(before).changes;
    },
  };
}
```

---

## `src/server/adapters/turso.ts` — stub

```ts
import type { DbAdapter } from "../../types";
import type { Client } from "@libsql/client";

// The SQL is identical to adapters/sqlite.ts. The only difference is the async
// client surface: `await client.execute({ sql, args })` and `client.batch([...])`
// for the insert transaction. Port each method over.
export function tursoAdapter(_client: Client): DbAdapter {
  return unimplemented("turso");
}

function unimplemented(name: string): DbAdapter {
  const fail = () =>
    Promise.reject(
      new Error(`tinywatch: '${name}' adapter not implemented yet — port the SQL from adapters/sqlite.ts`),
    );
  return {
    migrate: fail,
    insertEvents: fail,
    getVisitors: fail,
    getSessions: fail,
    getSectionDwell: fail,
    getTopCountries: fail,
  };
}
```

---

## `src/server/adapters/d1.ts` — stub

```ts
import type { DbAdapter } from "../../types";
import type { D1Database } from "@cloudflare/workers-types";

// D1 is a Workers binding, not an npm dependency — the user passes `env.DB`.
// Same SQLite dialect as adapters/sqlite.ts; use `db.prepare(sql).bind(...).run()`
// and `db.batch([...])` for inserts.
export function d1Adapter(_db: D1Database): DbAdapter {
  return unimplemented("d1");
}

function unimplemented(name: string): DbAdapter {
  const fail = () =>
    Promise.reject(
      new Error(`tinywatch: '${name}' adapter not implemented yet — port the SQL from adapters/sqlite.ts`),
    );
  return {
    migrate: fail,
    insertEvents: fail,
    getVisitors: fail,
    getSessions: fail,
    getSectionDwell: fail,
    getTopCountries: fail,
  };
}
```

---

## `src/server/adapters/postgres.ts` — stub

```ts
import type { DbAdapter } from "../../types";
import type { Pool } from "pg";

// Postgres dialect differs from SQLite in two places:
//   • placeholders are $1, $2, ... (not ?)
//   • JSON access is props->>'section' / (props->>'dwellMs')::int (not json_extract)
//   • store `props` as JSONB and use BIGINT for ts/received_at
// Otherwise the query shapes match adapters/sqlite.ts.
export function postgresAdapter(_pool: Pool): DbAdapter {
  return unimplemented("postgres");
}

function unimplemented(name: string): DbAdapter {
  const fail = () =>
    Promise.reject(
      new Error(`tinywatch: '${name}' adapter not implemented yet — port the SQL from adapters/sqlite.ts`),
    );
  return {
    migrate: fail,
    insertEvents: fail,
    getVisitors: fail,
    getSessions: fail,
    getSectionDwell: fail,
    getTopCountries: fail,
  };
}
```

---

## `src/cli.ts`

```ts
#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DbAdapter } from "./types";

const [cmd] = process.argv.slice(2);

async function loadConfig(): Promise<{ adapter: DbAdapter }> {
  // Looks for tinywatch.config.{mjs,js} in cwd exporting { adapter }.
  for (const file of ["tinywatch.config.mjs", "tinywatch.config.js"]) {
    try {
      const mod = await import(pathToFileURL(resolve(process.cwd(), file)).href);
      const cfg = mod.default ?? mod;
      if (cfg?.adapter) return cfg;
    } catch {
      // try the next filename
    }
  }
  throw new Error("tinywatch: could not find tinywatch.config.{mjs,js} exporting { adapter }");
}

async function main(): Promise<void> {
  switch (cmd) {
    case "migrate": {
      const { adapter } = await loadConfig();
      await adapter.migrate();
      console.log("✓ tinywatch: schema migrated");
      break;
    }
    default:
      console.log("Usage: tinywatch migrate");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
```

> The shebang on line 1 is required — tsup preserves it so `npx tinywatch migrate` is directly executable. A TS config file would need a loader; `.mjs`/`.js` works out of the box.

---

## `examples/tinywatch.config.mjs` — what your users write

```js
import Database from "better-sqlite3";
import { sqliteAdapter } from "tinywatch/server";

export default {
  adapter: sqliteAdapter(new Database("analytics.db")),
};
```

---

## `test/client.test.ts` — smoke test

```ts
import { describe, expect, it } from "vitest";
import { extractContext } from "../src/server/geo";

describe("extractContext", () => {
  it("prefers Cloudflare IP + country headers", () => {
    const req = new Request("https://x.test", {
      headers: { "cf-connecting-ip": "1.2.3.4", "cf-ipcountry": "US" },
    });
    const ctx = extractContext(req);
    expect(ctx.ip).toBe("1.2.3.4");
    expect(ctx.country).toBe("US");
  });

  it("falls back to the first x-forwarded-for entry", () => {
    const req = new Request("https://x.test", {
      headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" },
    });
    expect(extractContext(req).ip).toBe("9.9.9.9");
  });
});
```

---

## `README.md`

````md
# tinywatch

Tiny, embeddable web analytics. A ~600B client SDK plus a server handler that
writes to **your own** database. A dependency, not a deployment.

## Install

```bash
npm install tinywatch
# plus the driver for your database, e.g.
npm install better-sqlite3
```

## Client (2 lines)

```ts
import { init } from "tinywatch";

init({ endpoint: "/api/tw" });
```

Add `data-tw-track="signup_click"` to any element for click tracking, or
`data-tw-section="pricing"` to measure dwell time. No other wiring needed.

## Server (3 lines)

```ts
import Database from "better-sqlite3";
import { createHandler, sqliteAdapter } from "tinywatch/server";

const adapter = sqliteAdapter(new Database("analytics.db"));
export const POST = createHandler({ adapter }); // mount at /api/tw
```

## Migrate

```bash
npx tinywatch migrate
```

## Query

```ts
import { createQueries, sqliteAdapter } from "tinywatch/server";

const stats = createQueries({ adapter });
await stats.getVisitors();     // last 7 days
await stats.getTopCountries();
```

## Why not just use X?

tinywatch occupies a cell nobody else does: it's a **library** whose data lives
in **your** database. Everything adjacent is either a separate service you deploy
or a hosted backend you forward data to.

| Tool                    | Shape                | Data lives in                       | Dashboard      | Infra to run                          |
| ----------------------- | -------------------- | ----------------------------------- | -------------- | ------------------------------------- |
| **tinywatch**           | Library (import)     | Your DB (SQLite/Turso/D1/Postgres)  | Bring your own | None beyond your app                  |
| Counterscale            | Deployed Worker      | Cloudflare Analytics Engine (90d)   | Included       | Cloudflare account                    |
| Plausible/Umami/Rybbit  | Deployed service     | Their datastore                     | Included       | Separate server (Rybbit: ClickHouse)  |
| PostHog                 | Service + SDK        | PostHog cloud / heavy self-host     | Included       | Cloud, or Kafka+Redis+PG+ClickHouse   |
| Tinybird                | Hosted backend       | Tinybird (managed ClickHouse)       | Bring your own | SaaS account                          |

Two axes none of them occupy simultaneously: **library vs deployed service**, and
**your DB vs a vendor store**. tinywatch is the only "library + your DB" option.
If you want a turnkey dashboard with zero query code, one of the deployed tools is
a better fit. If you want events in your own database alongside your app data with
no extra infrastructure, that's tinywatch.

## License

MIT
````

> ⚠️ Verify the competitor facts in that table before you publish — the 90-day
> Analytics Engine cap, Rybbit's ClickHouse requirement, and PostHog's self-host
> stack are from research that should be re-checked against current docs.

---

## Where to go next (suggested order)

1. **`npm run build && npm run attw`** — confirm the `exports` map resolves and types aren't "wrong" for either module format. Fix any drift before writing more code.
2. **`npm run size`** — get a real number for the core path. If size-limit counts the lazy autocapture chunk against the 600B budget, scope the core entry or adjust the limit to reflect the synchronous critical path.
3. **Finish the Turso adapter** — it's the highest-value second backend (same SQL as SQLite, just async). Use it to prove the adapter interface holds across two real databases.
4. **Add a Vitest integration test** that runs `migrate → insertEvents → getVisitors` against an in-memory SQLite DB. That single test guards the whole server contract.
5. **Decide the plugin packaging** — DECIDED: first-party `use()` plugins ship under `tinywatch/plugins/*` subpaths (settled in the `exports` map). Third-party plugins remain possible via the exported `Plugin`/`PluginContext` types.
