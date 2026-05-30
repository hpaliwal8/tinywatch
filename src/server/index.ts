import type {
  EventBatch,
  HandlerConfig,
  QueriesConfig,
  RequestContext,
  StoredEvent,
  TimeRange,
  TinywatchEvent,
} from "../types";
import { extractContext } from "./geo";
import { rateLimited } from "./rate-limit";

/** Max events accepted in a single batch — bounds per-request write amplification. */
const MAX_BATCH = 1000;
/** Max serialized size of an event's props; oversized props are dropped, not stored. */
const MAX_PROPS_BYTES = 8 * 1024;
/** Max length for free-text string fields (name, path, ids). */
const MAX_STR = 1024;
/** How far a client `ts` may sit outside server time before we fall back to receivedAt. */
const MAX_PAST_MS = 7 * 864e5; // 7 days
// Tolerate ordinary client clock skew (drifted laptops are commonly minutes-to-
// hours fast); only clamp clearly-bogus far-future timestamps that could evade
// pruning. A day of slack still blocks the abuse case without flattening real data.
const MAX_FUTURE_MS = 864e5; // 1 day

/** Returns a portable Web-standard (Request → Response) ingestion handler. */
export function createHandler(config: HandlerConfig) {
  const { adapter, rateLimit = 120, cors = "*" } = config;
  const allowList = Array.isArray(cors) ? cors : null;

  // CORS must be computed per-request: when an allowlist is configured we echo
  // the caller's Origin if it's allowed (a comma-joined list is NOT a valid
  // Access-Control-Allow-Origin value). A single string or "*" is static.
  function corsHeaders(req: Request): Record<string, string> {
    let origin: string;
    let vary = false;
    if (allowList) {
      const reqOrigin = req.headers.get("origin");
      // Echo the match; otherwise return the first configured origin so a
      // disallowed caller is denied by the browser's same-origin check.
      origin = reqOrigin && allowList.includes(reqOrigin) ? reqOrigin : (allowList[0] ?? "*");
      vary = true;
    } else {
      origin = cors as string;
    }
    const headers: Record<string, string> = {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    };
    if (vary) headers["vary"] = "Origin";
    return headers;
  }

  return async function handler(req: Request): Promise<Response> {
    const headers = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405, headers);

    const ctx = extractContext(req);
    // Fall back to a shared bucket when no IP header is present, so header-less
    // clients can't bypass the limiter entirely. IPs must come from a trusted edge.
    if (rateLimited(ctx.ip ?? "unknown", rateLimit)) {
      return json({ error: "rate limited" }, 429, headers);
    }

    let batch: EventBatch;
    try {
      batch = (await req.json()) as EventBatch;
    } catch {
      return json({ error: "invalid json" }, 400, headers);
    }
    // Guard the container type, not just length: a non-array `events` with a
    // `length` prop would otherwise reach the for...of below and throw a 500.
    if (!Array.isArray(batch?.events) || batch.events.length === 0) {
      return json({ ok: true, stored: 0 }, 200, headers);
    }
    if (batch.events.length > MAX_BATCH) {
      return json({ error: "batch too large" }, 413, headers);
    }

    const now = Date.now();
    const rows: StoredEvent[] = [];
    for (const e of batch.events) {
      const row = normalize(e, ctx, now);
      if (row) rows.push(row);
    }
    await adapter.insertEvents(rows);
    return json({ ok: true, stored: rows.length }, 200, headers);
  };
}

/** Validate + sanitize one client event into a row, or null to skip it. */
function normalize(
  e: TinywatchEvent,
  ctx: RequestContext,
  now: number,
): StoredEvent | null {
  // Required string fields. A missing sessionId would violate NOT NULL and, in a
  // single transaction, reject the whole batch — so drop the event here instead.
  if (
    typeof e?.name !== "string" ||
    typeof e?.anonymousId !== "string" ||
    typeof e?.sessionId !== "string"
  ) {
    return null;
  }

  // Trust server time over a client-supplied ts that's implausibly skewed —
  // otherwise clients could backdate/post-date to evade range queries or pruning.
  let ts = typeof e.ts === "number" && Number.isFinite(e.ts) ? e.ts : now;
  if (ts < now - MAX_PAST_MS || ts > now + MAX_FUTURE_MS) ts = now;

  // Drop oversized props rather than storing unbounded blobs.
  let props = e.props;
  if (props && JSON.stringify(props).length > MAX_PROPS_BYTES) props = undefined;

  return {
    name: clamp(e.name),
    anonymousId: clamp(e.anonymousId),
    userId: typeof e.userId === "string" ? clamp(e.userId) : undefined,
    sessionId: clamp(e.sessionId),
    path: typeof e.path === "string" ? clamp(e.path) : "",
    props,
    ts,
    id: crypto.randomUUID(),
    country: ctx.country,
    city: ctx.city,
    userAgent: ctx.userAgent,
    receivedAt: now,
  };
}

function clamp(s: string): string {
  return s.length > MAX_STR ? s.slice(0, MAX_STR) : s;
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
