// Raw node:http — no framework at all. tinywatch's handler is a Web-standard
// (Request) => Promise<Response>, and Node's http server speaks its own
// IncomingMessage/ServerResponse, so this example is mostly the bridge between
// the two. Reach for Hono/Next/a framework if you'd rather not hand-write it.

import { createServer } from "node:http";
import Database from "better-sqlite3";
import { createHandler, sqliteAdapter } from "@hitansh8/tinywatch/server";

const adapter = sqliteAdapter(new Database("analytics.db"));
await adapter.migrate(); // ensure tables exist on boot
const handler = createHandler({ adapter });

const server = createServer(async (req, res) => {
  if (!req.url?.startsWith("/api/tw")) {
    res.writeHead(404).end("not found");
    return;
  }

  // node IncomingMessage -> Web Request
  const body = await readBody(req); // undefined for GET/OPTIONS
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body,
  });

  // Web Response -> node ServerResponse
  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
});

function readBody(req) {
  if (req.method === "GET" || req.method === "OPTIONS") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

server.listen(3000, () => console.log("tinywatch ingestion on http://localhost:3000/api/tw"));
