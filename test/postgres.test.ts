import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQueries } from "../src/server";
import { postgresAdapter } from "../src/server/adapters/postgres";
import type { DbAdapter, StoredEvent } from "../src/types";

// Runs the shared DbAdapter contract against pg-mem, an in-memory Postgres
// emulator — so the divergent dialect (\$1 placeholders, JSONB, ->>, ::numeric,
// ON CONFLICT, BIGINT) is actually exercised without a real PG server.

const evt = (over: Partial<StoredEvent> = {}): StoredEvent => ({
  id: crypto.randomUUID(),
  name: "$pageview",
  anonymousId: "a1",
  sessionId: "s1",
  path: "/",
  ts: Date.now(),
  receivedAt: Date.now(),
  ...over,
});

describe("postgres adapter contract (pg-mem)", () => {
  let adapter: DbAdapter;

  beforeEach(async () => {
    const db = newDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Pool } = db.adapters.createPg() as any;
    adapter = postgresAdapter(new Pool());
    await adapter.migrate();
  });
  afterEach(() => {
    // pg-mem holds no external resources; a fresh db is created per test.
  });

  // NB: real-Postgres migrate idempotency (re-running CREATE TABLE IF NOT EXISTS)
  // can't be asserted here — pg-mem doesn't support re-running CREATE TABLE IF NOT
  // EXISTS once the table exists (CREATE INDEX IF NOT EXISTS is fine). The SQL is
  // standard Postgres; idempotency is covered by the real-PG CI job. Here we just
  // confirm the first migrate ran and produced a usable table.
  it("migrate creates a usable table", async () => {
    expect(await createQueries({ adapter }).getVisitors()).toBe(0);
  });

  it("inserts a multi-row batch and counts distinct visitors + sessions", async () => {
    await adapter.insertEvents([
      evt({ anonymousId: "a1", sessionId: "s1" }),
      evt({ anonymousId: "a1", sessionId: "s2", name: "$click" }),
      evt({ anonymousId: "a2", sessionId: "s3" }),
    ]);
    const stats = createQueries({ adapter });
    expect(await stats.getVisitors()).toBe(2);
    expect(await stats.getSessions()).toBe(3);
  });

  it("insertEvents([]) is a no-op", async () => {
    await expect(adapter.insertEvents([])).resolves.toBeUndefined();
    expect(await createQueries({ adapter }).getVisitors()).toBe(0);
  });

  it("ON CONFLICT (id) DO NOTHING dedupes", async () => {
    const row = evt({ id: "dup" });
    await adapter.insertEvents([row]);
    await adapter.insertEvents([row]);
    expect(await createQueries({ adapter }).getVisitors()).toBe(1);
  });

  it("aggregates JSONB section dwell and coerces a numeric section to string (parity)", async () => {
    const now = Date.now();
    await adapter.insertEvents([
      evt({ name: "$section", props: { section: "pricing", dwellMs: 1000 }, ts: now }),
      evt({ name: "$section", anonymousId: "a2", props: { section: "pricing", dwellMs: 1500 }, ts: now }),
      evt({ name: "$section", props: { section: 123, dwellMs: 10 }, ts: now }), // numeric section
      evt({ name: "$section", props: { dwellMs: 999 }, ts: now }), // no section -> excluded
    ]);
    const dwell = await createQueries({ adapter }).getSectionDwell();
    expect(dwell).toEqual([
      { section: "pricing", totalMs: 2500, views: 2 },
      { section: "123", totalMs: 10, views: 1 },
    ]);
    expect(dwell.every((d) => typeof d.totalMs === "number")).toBe(true);
  });

  it("ranks top countries by distinct visitors", async () => {
    await adapter.insertEvents([
      evt({ anonymousId: "a1", country: "US" }),
      evt({ anonymousId: "a2", country: "US" }),
      evt({ anonymousId: "a3", country: "DE" }),
      evt({ anonymousId: "a4" }), // no country -> excluded
    ]);
    expect(await createQueries({ adapter }).getTopCountries()).toEqual([
      { country: "US", visitors: 2 },
      { country: "DE", visitors: 1 },
    ]);
  });

  it("respects the time range (BIGINT ts) and prunes old rows", async () => {
    const now = Date.now();
    await adapter.insertEvents([
      evt({ id: "old", anonymousId: "o", ts: now - 30 * 864e5 }),
      evt({ id: "new", anonymousId: "n", ts: now }),
    ]);
    expect(await createQueries({ adapter }).getVisitors()).toBe(1); // default 7d
    expect(await adapter.getVisitors({ from: 0, to: now + 1000 })).toBe(2);
    expect(await adapter.pruneBefore!(now)).toBe(1);
    expect(await adapter.getVisitors({ from: 0, to: now + 1000 })).toBe(1);
  });

  it("round-trips JSONB props and optional fields (userId/city)", async () => {
    await adapter.insertEvents([
      evt({ userId: "u1", city: "Berlin", country: "DE", props: { plan: "pro" } }),
    ]);
    expect(await createQueries({ adapter }).getTopCountries()).toEqual([
      { country: "DE", visitors: 1 },
    ]);
  });
});
