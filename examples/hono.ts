// Hono — the "portable Web handler" story. The same file runs on Node, Bun,
// Deno, and Cloudflare Workers because Hono and tinywatch both speak the Web
// Request/Response standard. Paired here with Turso (libsql).

import { createClient } from "@libsql/client";
import { Hono } from "hono";
import { createHandler, tursoAdapter } from "tinywatch/server";

const client = createClient({
  url: process.env.TURSO_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const handler = createHandler({ adapter: tursoAdapter(client) });

const app = new Hono();

// c.req.raw is the underlying Web Request — hand it straight to the handler.
app.all("/api/tw", (c) => handler(c.req.raw));

export default app;

// Node:   import { serve } from "@hono/node-server"; serve(app)
// Bun:    export default app  (Bun.serve picks it up)
// Workers: export default app
