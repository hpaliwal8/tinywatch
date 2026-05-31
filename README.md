# tinywatch

Tiny, embeddable web analytics. A ~900B client SDK plus a server handler that
writes to **your own** database. A dependency, not a deployment.

## Install

```bash
npm install @hitansh8/tinywatch
# plus the driver for your database, e.g.
npm install better-sqlite3
```

## Client (2 lines)

```ts
import { init } from "@hitansh8/tinywatch";

init({ endpoint: "/api/tw" });
```

Add `data-tw-track="signup_click"` to any element for click tracking, or
`data-tw-section="pricing"` to measure dwell time. No other wiring needed.

## Server (3 lines)

```ts
import Database from "better-sqlite3";
import { createHandler, sqliteAdapter } from "@hitansh8/tinywatch/server";

const adapter = sqliteAdapter(new Database("analytics.db"));
export const POST = createHandler({ adapter }); // mount at /api/tw
```

## Migrate

```bash
npx @hitansh8/tinywatch migrate
```

## Query

```ts
import { createQueries, sqliteAdapter } from "@hitansh8/tinywatch/server";

const stats = createQueries({ adapter });
await stats.getVisitors();     // last 7 days
await stats.getTopCountries();
```

Any adapter works the same way — swap `sqliteAdapter` for `tursoAdapter`,
`d1Adapter`, or `postgresAdapter`.

## Plugins

Opt-in behavior via `use()`. Each plugin is its own ~250–300 B chunk loaded only
when you import it — you pay for nothing you don't use.

```ts
import { init, use } from "@hitansh8/tinywatch";
import { outbound } from "@hitansh8/tinywatch/plugins/outbound";
import { retry } from "@hitansh8/tinywatch/plugins/retry";

init({ endpoint: "/api/tw" });
use(outbound());               // track clicks to external sites as "$outbound"
use(retry({ maxRetries: 5 })); // re-deliver failed flushes with exponential backoff
```

Write your own with the `Plugin` / `PluginContext` types from `@hitansh8/tinywatch`.
See [examples/](examples/) for framework mounts (Next.js, Cloudflare Workers,
Hono, raw Node) and more.

## Lifecycle

`init()` is idempotent. For SPA re-init, hot-reload, or teardown, call
`shutdown()` — it flushes, removes all listeners, restores patched history, and
resets state so `init()` can run cleanly again.

## Why not just use X?

tinywatch occupies a cell nobody else does: it's a **library** whose data lives
in **your** database. Everything adjacent is either a separate service you deploy
or a hosted backend you forward data to.

| Tool                    | Shape                | Data lives in                       | Dashboard      | Infra to run                          |
| ----------------------- | -------------------- | ----------------------------------- | -------------- | ------------------------------------- |
| **tinywatch**           | Library (import)     | Your DB (SQLite/Turso/D1/Postgres)  | Bring your own | None beyond your app                  |
| Counterscale            | Deployed Worker      | Cloudflare Analytics Engine (90d¹)  | Included       | Cloudflare account                    |
| Plausible/Umami/Rybbit  | Deployed service     | Their datastore                     | Included       | Separate server (Plausible/Rybbit: ClickHouse) |
| PostHog                 | Service + SDK        | PostHog cloud (self-host²)          | Included       | Cloud, or Kafka+Redis+PG+ClickHouse   |
| Tinybird                | Hosted backend       | Tinybird (managed ClickHouse)       | Bring your own | SaaS account                          |

Two axes none of them occupy simultaneously: **library vs deployed service**, and
**your DB vs a vendor store**. tinywatch is the only "library + your DB" option.
If you want a turnkey dashboard with zero query code, one of the deployed tools is
a better fit. If you want events in your own database alongside your app data with
no extra infrastructure, that's tinywatch.

<sub>¹ Analytics Engine retains 90 days; Counterscale can additionally archive to R2 (Apache Arrow) for longer retention.
² PostHog's open-source self-host still exists (Docker "hobby" deploy) but is no longer recommended — Kubernetes deploys are deprecated, there's no support, and it targets ~100k events/mo before migrating to Cloud.
<br>Competitor facts verified 2026-05-29 against vendor docs ([Counterscale](https://github.com/benvinegar/counterscale), [Rybbit](https://rybbit.com/docs/self-hosting-guides/self-hosting-manual), [PostHog](https://posthog.com/docs/self-host), [Plausible](https://clickhouse.com/blog/plausible-analytics-uses-click-house-to-power-their-privacy-friendly-google-analytics-alternative), [Umami](https://github.com/umami-software/umami), [Tinybird](https://www.tinybird.co/clickhouse)).</sub>

## License

MIT
