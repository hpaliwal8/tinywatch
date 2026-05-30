import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHandler, createQueries, sqliteAdapter } from "../src/server";
import { __resetRateLimiter } from "../src/server/rate-limit";
import type { DbAdapter } from "../src/types";

function batchRequest(events: unknown[], headers: Record<string, string> = {}): Request {
  return new Request("https://x.test/api/tw", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ events, v: "test" }),
  });
}

const validEvent = (over: Record<string, unknown> = {}) => ({
  name: "$pageview",
  anonymousId: "a1",
  sessionId: "s1",
  path: "/",
  ts: Date.now(),
  ...over,
});

describe("sqlite adapter + handler contract", () => {
  let db: Database.Database;
  let adapter: DbAdapter;

  beforeEach(async () => {
    __resetRateLimiter(); // keep tests order-independent
    db = new Database(":memory:");
    adapter = sqliteAdapter(db);
    await adapter.migrate();
  });

  afterEach(() => db.close());

  it("migrate is idempotent (safe to run twice)", async () => {
    await expect(adapter.migrate()).resolves.toBeUndefined();
  });

  it("ingests a batch through createHandler and persists rows", async () => {
    const handler = createHandler({ adapter });
    const res = await handler(
      batchRequest(
        [
          { name: "$pageview", anonymousId: "a1", sessionId: "s1", path: "/", ts: Date.now() },
          { name: "$pageview", anonymousId: "a2", sessionId: "s2", path: "/x", ts: Date.now() },
        ],
        { "cf-connecting-ip": "1.1.1.1", "cf-ipcountry": "US" },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stored: 2 });

    const stats = createQueries({ adapter });
    expect(await stats.getVisitors()).toBe(2);
    expect(await stats.getSessions()).toBe(2);

    // Geo from headers should have been attached server-side.
    const countries = await stats.getTopCountries();
    expect(countries).toEqual([{ country: "US", visitors: 2 }]);
  });

  it("counts distinct anonymous ids and sessions, not raw rows", async () => {
    const now = Date.now();
    const handler = createHandler({ adapter });
    await handler(
      batchRequest([
        { name: "$pageview", anonymousId: "a1", sessionId: "s1", path: "/", ts: now },
        { name: "$click", anonymousId: "a1", sessionId: "s1", path: "/", ts: now },
        { name: "$pageview", anonymousId: "a1", sessionId: "s2", path: "/", ts: now },
      ]),
    );
    const stats = createQueries({ adapter });
    expect(await stats.getVisitors()).toBe(1); // one anon id
    expect(await stats.getSessions()).toBe(2); // two sessions
  });

  it("aggregates section dwell from $section props", async () => {
    const now = Date.now();
    await adapter.insertEvents([
      {
        id: "e1", name: "$section", anonymousId: "a1", sessionId: "s1", path: "/",
        props: { section: "pricing", dwellMs: 1000 }, ts: now, receivedAt: now,
      },
      {
        id: "e2", name: "$section", anonymousId: "a2", sessionId: "s2", path: "/",
        props: { section: "pricing", dwellMs: 1500 }, ts: now, receivedAt: now,
      },
      {
        id: "e3", name: "$section", anonymousId: "a1", sessionId: "s1", path: "/",
        props: { section: "hero", dwellMs: 400 }, ts: now, receivedAt: now,
      },
    ]);
    const stats = createQueries({ adapter });
    const dwell = await stats.getSectionDwell();
    expect(dwell).toEqual([
      { section: "pricing", totalMs: 2500, views: 2 },
      { section: "hero", totalMs: 400, views: 1 },
    ]);
  });

  it("respects the time range (events outside the window are excluded)", async () => {
    const now = Date.now();
    const old = now - 30 * 864e5; // 30 days ago
    await adapter.insertEvents([
      { id: "old", name: "$pageview", anonymousId: "old", sessionId: "s", path: "/", ts: old, receivedAt: now },
      { id: "new", name: "$pageview", anonymousId: "new", sessionId: "s", path: "/", ts: now, receivedAt: now },
    ]);
    const stats = createQueries({ adapter });
    expect(await stats.getVisitors()).toBe(1); // default range is last 7 days
    expect(await adapter.getVisitors({ from: 0, to: now })).toBe(2);
  });

  it("skips malformed events but stores the valid ones", async () => {
    const handler = createHandler({ adapter });
    const res = await handler(
      batchRequest([
        { name: "$pageview", anonymousId: "a1", sessionId: "s1", path: "/", ts: Date.now() },
        { name: 123, anonymousId: "a2", sessionId: "s2", path: "/", ts: Date.now() }, // bad name
        { anonymousId: "a3", sessionId: "s3", path: "/", ts: Date.now() }, // missing name
      ]),
    );
    expect(await res.json()).toEqual({ ok: true, stored: 1 });
  });

  it("returns 400 on invalid JSON and 405 on non-POST", async () => {
    const handler = createHandler({ adapter });
    const bad = new Request("https://x.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect((await handler(bad)).status).toBe(400);

    const get = new Request("https://x.test", { method: "GET" });
    expect((await handler(get)).status).toBe(405);

    const opts = new Request("https://x.test", { method: "OPTIONS" });
    expect((await handler(opts)).status).toBe(204);
  });

  it("pruneBefore deletes old rows and reports the count", async () => {
    const now = Date.now();
    await adapter.insertEvents([
      { id: "old", name: "$pageview", anonymousId: "a1", sessionId: "s", path: "/", ts: now - 1000, receivedAt: now },
      { id: "new", name: "$pageview", anonymousId: "a2", sessionId: "s", path: "/", ts: now + 1000, receivedAt: now },
    ]);
    const deleted = await adapter.pruneBefore!(now);
    expect(deleted).toBe(1);
    expect(await adapter.getVisitors({ from: 0, to: now + 5000 })).toBe(1);
  });
});

describe("handler hardening", () => {
  let db: Database.Database;
  let adapter: DbAdapter;

  beforeEach(async () => {
    __resetRateLimiter();
    db = new Database(":memory:");
    adapter = sqliteAdapter(db);
    await adapter.migrate();
  });
  afterEach(() => db.close());

  it("drops events missing sessionId without poisoning the rest of the batch", async () => {
    const handler = createHandler({ adapter });
    const res = await handler(
      batchRequest([
        validEvent({ anonymousId: "ok" }),
        { name: "$pageview", anonymousId: "nosession", path: "/", ts: Date.now() }, // no sessionId
      ]),
    );
    // Without the validation fix, the missing sessionId would hit NOT NULL and
    // throw, rejecting the whole transaction.
    expect(await res.json()).toEqual({ ok: true, stored: 1 });
    expect(await createQueries({ adapter }).getVisitors()).toBe(1);
  });

  it("rejects an oversized batch with 413", async () => {
    const handler = createHandler({ adapter });
    const events = Array.from({ length: 1001 }, (_, i) => validEvent({ anonymousId: `a${i}` }));
    const res = await handler(batchRequest(events));
    expect(res.status).toBe(413);
    expect(await createQueries({ adapter }).getVisitors()).toBe(0);
  });

  it("clamps an implausible client ts to server time", async () => {
    const handler = createHandler({ adapter });
    const farFuture = Date.now() + 365 * 864e5; // 1 year ahead
    await handler(batchRequest([validEvent({ ts: farFuture })]));
    // Clamped to ~now, so it lands inside the default 7-day window.
    expect(await createQueries({ adapter }).getVisitors()).toBe(1);
  });

  it("CORS: echoes an allowlisted Origin and denies others", async () => {
    const handler = createHandler({ adapter, cors: ["https://app.example"] });
    const allowed = await handler(
      batchRequest([validEvent()], { origin: "https://app.example" }),
    );
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(allowed.headers.get("vary")).toBe("Origin");

    const denied = await handler(
      batchRequest([validEvent()], { origin: "https://evil.example" }),
    );
    // Never echoes a comma-joined list; returns a single non-matching origin.
    expect(denied.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(denied.headers.get("access-control-allow-origin")).not.toContain(",");
  });

  it("CORS: wildcard default is a single '*' with no Vary", async () => {
    const handler = createHandler({ adapter });
    const res = await handler(batchRequest([validEvent()]));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("vary")).toBeNull();
  });

  it("rate-limits header-less clients via a shared bucket (no bypass)", async () => {
    const handler = createHandler({ adapter, rateLimit: 2 });
    // No IP headers — all share the "unknown" bucket.
    expect((await handler(batchRequest([validEvent()]))).status).toBe(200);
    expect((await handler(batchRequest([validEvent()]))).status).toBe(200);
    expect((await handler(batchRequest([validEvent()]))).status).toBe(429);
  });

  it("getSectionDwell skips $section events with no section prop and never returns null totals", async () => {
    const now = Date.now();
    await adapter.insertEvents([
      { id: "e1", name: "$section", anonymousId: "a", sessionId: "s", path: "/", props: { section: "pricing", dwellMs: 500 }, ts: now, receivedAt: now },
      { id: "e2", name: "$section", anonymousId: "a", sessionId: "s", path: "/", props: { dwellMs: 999 }, ts: now, receivedAt: now }, // no section
    ]);
    const dwell = await createQueries({ adapter }).getSectionDwell();
    expect(dwell).toEqual([{ section: "pricing", totalMs: 500, views: 1 }]);
    expect(dwell.every((d) => typeof d.totalMs === "number")).toBe(true);
  });

  it("coerces a numeric section value to a string (parity with the turso adapter)", async () => {
    const now = Date.now();
    await adapter.insertEvents([
      { id: "n1", name: "$section", anonymousId: "a", sessionId: "s", path: "/", props: { section: 123, dwellMs: 10 }, ts: now, receivedAt: now },
    ]);
    const [row] = await createQueries({ adapter }).getSectionDwell();
    expect(row).toEqual({ section: "123", totalMs: 10, views: 1 });
    expect(typeof row!.section).toBe("string");
  });

  it("returns ok:0 (not 500) when events is not an array", async () => {
    const handler = createHandler({ adapter });
    const req = new Request("https://x.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: { length: 5 }, v: "x" }), // non-array with length
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stored: 0 });
  });

  it("keeps a moderately future ts (clock skew) instead of flattening it", async () => {
    const now = Date.now();
    const tenMinFast = now + 10 * 60_000;
    const handler = createHandler({ adapter });
    await handler(batchRequest([validEvent({ ts: tenMinFast })]));
    // 10 min skew is within the 1-day future window, so the ts is preserved.
    // A query window that includes the future ts finds it...
    expect(await adapter.getVisitors({ from: now - 1000, to: tenMinFast + 1000 })).toBe(1);
    // ...but a window ending before it (e.g. one that stops at the old 5-min cap)
    // does NOT — proving the ts was kept at +10min, not flattened back to ~now.
    expect(await adapter.getVisitors({ from: now - 1000, to: now + 5 * 60_000 })).toBe(0);
  });
});
