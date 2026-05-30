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
