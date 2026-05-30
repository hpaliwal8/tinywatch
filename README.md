# tinywatch

Tiny, embeddable web analytics. A ~900B client SDK plus a server handler that
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
