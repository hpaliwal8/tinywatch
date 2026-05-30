import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQueries } from "../src/server";
import { d1Adapter } from "../src/server/adapters/d1";
import type { DbAdapter, StoredEvent } from "../src/types";

// D1 has no in-memory npm driver, but it speaks the same SQLite dialect. This
// shim implements the slice of the D1Database API the adapter uses, backed by
// better-sqlite3 — so we exercise the adapter's SQL, bindings, batch atomicity
// and row projection without pulling in miniflare/workers-pool.
//
// Mirrors D1: prepare(sql) -> { bind(...args), run(), all() }, and db.batch([...])
// runs the prepared+bound statements inside one transaction.

interface ShimStmt {
  sql: string;
  args: unknown[];
  bind(...args: unknown[]): ShimStmt;
  run(): Promise<{ success: true; meta: { changes: number }; results: never[] }>;
  all<T = unknown>(): Promise<{ success: true; meta: object; results: T[] }>;
}

function makeD1(db: Database.Database) {
  // D1's .bind() returns a NEW bound statement (it doesn't mutate), which is
  // what lets db.batch([stmt.bind(...), stmt.bind(...)]) hold many distinct
  // bindings of the same prepared statement. Model each as an immutable record.
  function makeStmt(sql: string, args: unknown[]): ShimStmt {
    return {
      sql,
      args,
      bind(...next: unknown[]) {
        return makeStmt(sql, next);
      },
      async run() {
        const info = db.prepare(sql).run(...(args as never[]));
        return { success: true as const, meta: { changes: info.changes }, results: [] };
      },
      async all<T = unknown>() {
        const results = db.prepare(sql).all(...(args as never[])) as T[];
        return { success: true as const, meta: {}, results };
      },
    };
  }

  return {
    prepare: (sql: string) => makeStmt(sql, []),
    async batch(statements: ShimStmt[]) {
      const tx = db.transaction((stmts: ShimStmt[]) => {
        for (const s of stmts) db.prepare(s.sql).run(...(s.args as never[]));
      });
      tx(statements);
      return statements.map(() => ({ success: true as const, meta: {}, results: [] }));
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}

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

describe("d1 adapter contract (better-sqlite3-backed D1 shim)", () => {
  let db: Database.Database;
  let adapter: DbAdapter;

  beforeEach(async () => {
    db = new Database(":memory:");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adapter = d1Adapter(makeD1(db) as any);
    await adapter.migrate();
  });
  afterEach(() => db.close());

  it("migrate is idempotent", async () => {
    await expect(adapter.migrate()).resolves.toBeUndefined();
  });

  it("inserts a batch and counts distinct visitors + sessions", async () => {
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

  it("INSERT OR IGNORE dedupes on id", async () => {
    const row = evt({ id: "dup" });
    await adapter.insertEvents([row]);
    await adapter.insertEvents([row]);
    expect(await createQueries({ adapter }).getVisitors()).toBe(1);
  });

  it("dedupes duplicate ids within a single batch (parity)", async () => {
    // The d1 adapter does NOT JS-dedup; this passes because INSERT OR IGNORE
    // skips the 2nd row on PK conflict (better-sqlite3 .run() doesn't throw).
    // Don't "fix" the adapter by adding JS dedup — the SQL handles it.
    await adapter.insertEvents([evt({ id: "same", anonymousId: "first" }), evt({ id: "same", anonymousId: "second" })]);
    expect(await createQueries({ adapter }).getVisitors()).toBe(1);
  });

  it("aggregates section dwell and coerces a numeric section to string (parity)", async () => {
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
  });

  it("ranks top countries by distinct visitors", async () => {
    await adapter.insertEvents([
      evt({ anonymousId: "a1", country: "US" }),
      evt({ anonymousId: "a2", country: "US" }),
      evt({ anonymousId: "a3", country: "DE" }),
      evt({ anonymousId: "a4" }),
    ]);
    expect(await createQueries({ adapter }).getTopCountries()).toEqual([
      { country: "US", visitors: 2 },
      { country: "DE", visitors: 1 },
    ]);
  });

  it("respects the time range and prunes old rows", async () => {
    const now = Date.now();
    await adapter.insertEvents([
      evt({ id: "old", anonymousId: "o", ts: now - 1000 }),
      evt({ id: "new", anonymousId: "n", ts: now + 1000 }),
    ]);
    expect(await adapter.pruneBefore!(now)).toBe(1);
    expect(await adapter.getVisitors({ from: 0, to: now + 5000 })).toBe(1);
  });
});
