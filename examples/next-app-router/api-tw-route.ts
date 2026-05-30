// Next.js App Router — ingestion endpoint.
// Place at: app/api/tw/route.ts
//
// createHandler returns a Web-standard (Request) => Promise<Response>, which is
// exactly what an App Router route handler is — so you export it directly.

import Database from "better-sqlite3";
import { createHandler, sqliteAdapter } from "tinywatch/server";

// Reuse one adapter across requests. In a serverless deployment each instance
// gets its own SQLite file/connection; for multi-instance use a shared DB
// (Postgres/Turso) instead — swap sqliteAdapter for postgresAdapter/tursoAdapter.
const adapter = sqliteAdapter(new Database("analytics.db"));

const handler = createHandler({
  adapter,
  // Lock CORS to your site(s) in production instead of the "*" default:
  // cors: ["https://yourapp.com"],
});

// The client posts batches here; OPTIONS handles the CORS preflight.
export const POST = handler;
export const OPTIONS = handler;

// Run `npx tinywatch migrate` once (with a tinywatch.config.mjs exporting
// { adapter }) to create the tables before first use.
