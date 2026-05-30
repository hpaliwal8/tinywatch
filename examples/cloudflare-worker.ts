// Cloudflare Workers — ingestion on the edge, backed by a D1 binding.
//
// D1 is a Worker binding (env.DB), not an npm package — so the d1 adapter takes
// the binding directly. The handler is the same Web-standard (Request) => Response
// that the Worker `fetch` already speaks, so mounting is a one-liner.
//
// wrangler.toml needs a D1 binding:
//   [[d1_databases]]
//   binding = "DB"
//   database_name = "analytics"
//   database_id = "<your-d1-id>"

import { createHandler, d1Adapter } from "tinywatch/server";

interface Env {
  DB: D1Database; // from @cloudflare/workers-types
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Mount the ingestion handler at /api/tw; serve everything else yourself.
    const url = new URL(req.url);
    if (url.pathname === "/api/tw") {
      return createHandler({ adapter: d1Adapter(env.DB) })(req);
    }
    return new Response("not found", { status: 404 });
  },
};

// Create the schema once with: `wrangler d1 execute analytics --command "..."`,
// or run adapter.migrate() from a one-off script / Worker route.
