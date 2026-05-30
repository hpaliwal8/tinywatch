import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQueries } from "../src/server";
import { postgresAdapter } from "../src/server/adapters/postgres";
import type { DbAdapter, StoredEvent } from "../src/types";

// Runs against a REAL Postgres (TINYWATCH_PG_URL), covering the gaps pg-mem
// can't: migrate idempotency (CREATE TABLE IF NOT EXISTS re-run), the
// numeric-cast behavior on non-numeric dwellMs, and the 65535 parameter ceiling.
// Skipped entirely when TINYWATCH_PG_URL is unset (local runs, the main CI job).

const PG_URL = process.env.TINYWATCH_PG_URL;

const evt = (over: Partial<StoredEvent> = {}): StoredEvent => ({
  id: randomUUID(),
  name: "$pageview",
  anonymousId: "a1",
  sessionId: "s1",
  path: "/",
  ts: Date.now(),
  receivedAt: Date.now(),
  ...over,
});

describe.skipIf(!PG_URL)("postgres adapter against a real Postgres", () => {
  let pool: Pool;
  let adapter: DbAdapter;

  beforeEach(async () => {
    pool = new Pool({ connectionString: PG_URL });
    adapter = postgresAdapter(pool);
    await pool.query("DROP TABLE IF EXISTS tw_events");
    await adapter.migrate();
  });

  afterEach(async () => {
    await pool.query("DROP TABLE IF EXISTS tw_events");
    await pool.end();
  });
  afterAll(async () => {
    // pools are per-test; nothing global to clean.
  });

  it("migrate is idempotent (re-running CREATE TABLE IF NOT EXISTS does not throw)", async () => {
    // pg-mem can't re-run CREATE TABLE IF NOT EXISTS; real PG must.
    await expect(adapter.migrate()).resolves.toBeUndefined();
    await expect(adapter.migrate()).resolves.toBeUndefined();
    expect(await createQueries({ adapter }).getVisitors()).toBe(0);
  });

  it("counts distinct visitors/sessions and aggregates JSONB dwell", async () => {
    const now = Date.now();
    await adapter.insertEvents([
      evt({ anonymousId: "a1", sessionId: "s1" }),
      evt({ anonymousId: "a1", sessionId: "s2", name: "$click" }),
      evt({ anonymousId: "a2", sessionId: "s3" }),
      evt({ name: "$section", props: { section: "pricing", dwellMs: 1000 }, ts: now }),
      evt({ name: "$section", props: { section: 123, dwellMs: 10 }, ts: now }),
    ]);
    const stats = createQueries({ adapter });
    expect(await stats.getVisitors()).toBe(2);
    expect(await stats.getSessions()).toBe(3);
    const dwell = await stats.getSectionDwell();
    // numeric section coerced to string, parity with the other adapters
    expect(dwell).toContainEqual({ section: "pricing", totalMs: 1000, views: 1 });
    expect(dwell).toContainEqual({ section: "123", totalMs: 10, views: 1 });
    expect(dwell.every((d) => typeof d.totalMs === "number" && typeof d.section === "string")).toBe(true);
  });

  it("dedupes duplicate ids within a single batch (no cardinality violation)", async () => {
    // The JS dedup must prevent a multi-row INSERT ... ON CONFLICT from seeing
    // two rows with the same id. Without it this could error on real PG.
    await adapter.insertEvents([
      evt({ id: "same", anonymousId: "first" }),
      evt({ id: "same", anonymousId: "second" }),
    ]);
    expect(await createQueries({ adapter }).getVisitors()).toBe(1);
  });

  it("inserts beyond the 65535 parameter ceiling via chunking", async () => {
    // 6000 events * 12 params = 72000 > 65535 — a single INSERT would fail on
    // real PG; the adapter must chunk. pg-mem can't catch this.
    const n = 6000;
    const events = Array.from({ length: n }, (_, i) => evt({ anonymousId: `a${i}` }));
    await adapter.insertEvents(events);
    expect(await adapter.getVisitors({ from: 0, to: Date.now() + 1000 })).toBe(n);
  });

  it("non-numeric dwellMs: documents real-PG behavior of the bare ::numeric cast", async () => {
    // Known divergence (tracked): on real PG, (props->>'dwellMs')::numeric throws
    // on a non-numeric string, whereas the SQLite-family adapters coerce. This
    // test PINS the current real-PG behavior so a future guard fix is verified
    // here. If/when the adapter guards the cast, change this to expect success.
    await adapter.insertEvents([
      evt({ name: "$section", props: { section: "bad", dwellMs: "100ms" } }),
    ]);
    await expect(createQueries({ adapter }).getSectionDwell()).rejects.toThrow();
  });
});
