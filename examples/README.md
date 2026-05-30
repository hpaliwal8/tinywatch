# tinywatch examples

The server handler is a single Web-standard function — `(Request) => Promise<Response>` —
so "mounting" it is the same one call everywhere; the examples differ mainly in
the framework glue and which adapter/runtime they pair with.

| Example | Runtime | Adapter | Shows |
| ------- | ------- | ------- | ----- |
| [`next-app-router/`](./next-app-router) | Next.js (Node/edge) | SQLite | Full-stack: ingestion route (`POST`/`OPTIONS`) + a server-rendered dashboard via `createQueries` |
| [`cloudflare-worker.ts`](./cloudflare-worker.ts) | Cloudflare Workers | D1 | Edge runtime + a binding (`env.DB`) instead of an npm client |
| [`hono.ts`](./hono.ts) | Node / Bun / Deno / Workers | Turso | One portable file that runs anywhere Web `Request`/`Response` does |
| [`node-http.mjs`](./node-http.mjs) | `node:http` | SQLite | No framework — the manual `IncomingMessage` ⇄ `Request`/`Response` bridge |

`tinywatch.config.mjs` is what `npx tinywatch migrate` reads to create your tables.

## The two-line client (any of the above)

```ts
import { init } from "tinywatch";
init({ endpoint: "/api/tw" });
```

Then `data-tw-track="signup"` / `data-tw-section="pricing"` attributes do the rest.

## Plugins

First-party plugins live at `tinywatch/plugins/*` and register via `use()`:

```ts
import { init, use } from "tinywatch";
import { outbound } from "tinywatch/plugins/outbound";

init({ endpoint: "/api/tw" });
use(outbound()); // tracks clicks to external sites as "$outbound"
```

`outbound` options: `eventName` (default `"$outbound"`) and `internalHosts`
(extra hostnames to treat as internal). Each plugin is its own ~300 B chunk —
you only pay for what you `use()`.

## Notes

- **CORS:** the handler defaults to `*`. In production pass `cors: ["https://yourapp.com"]`
  — it echoes an allowed `Origin` back and ignores others.
- **Adapters are interchangeable:** every example works with any adapter
  (`sqliteAdapter` / `tursoAdapter` / `d1Adapter` / `postgresAdapter`) — swap the
  one line that constructs it. SQLite is per-instance; use Postgres/Turso/D1 for
  multi-instance or serverless deployments.
- **Migrate first:** run `npx tinywatch migrate` (or call `adapter.migrate()`) once
  before sending events.
