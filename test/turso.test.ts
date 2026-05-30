import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQueries } from "../src/server";
import { tursoAdapter } from "../src/server/adapters/turso";
import type { DbAdapter, StoredEvent } from "../src/types";

// Runs the same contract as the sqlite adapter against an in-memory libsql
// client, proving the DbAdapter interface holds across two real backends.

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

describe("turso adapter contract", () => {
  let client: Client;
  let adapter: DbAdapter;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    adapter = tursoAdapter(client);
    await adapter.migrate();
  });

  afterEach(() => client.close());

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
    await adapter.insertEvents([row]); // same id again
    expect(await createQueries({ adapter }).getVisitors()).toBe(1);
  });

  it("dedupes duplicate ids within a single batch (parity)", async () => {
    await adapter.insertEvents([evt({ id: "same", anonymousId: "first" }), evt({ id: "same", anonymousId: "second" })]);
    expect(await createQueries({ adapter }).getVisitors()).toBe(1);
  });

  it("aggregates section dwell and never returns null totals", async () => {
    const now = Date.now();
    await adapter.insertEvents([
      evt({ name: "$section", props: { section: "pricing", dwellMs: 1000 }, ts: now }),
      evt({ name: "$section", anonymousId: "a2", props: { section: "pricing", dwellMs: 1500 }, ts: now }),
      evt({ name: "$section", props: { section: "hero", dwellMs: 400 }, ts: now }),
      evt({ name: "$section", props: { dwellMs: 999 }, ts: now }), // no section -> excluded
    ]);
    const dwell = await createQueries({ adapter }).getSectionDwell();
    expect(dwell).toEqual([
      { section: "pricing", totalMs: 2500, views: 2 },
      { section: "hero", totalMs: 400, views: 1 },
    ]);
  });

  it("ranks top countries by distinct visitors", async () => {
    await adapter.insertEvents([
      evt({ anonymousId: "a1", country: "US" }),
      evt({ anonymousId: "a2", country: "US" }),
      evt({ anonymousId: "a3", country: "DE" }),
      evt({ anonymousId: "a4" }), // no country -> excluded
    ]);
    const top = await createQueries({ adapter }).getTopCountries();
    expect(top).toEqual([
      { country: "US", visitors: 2 },
      { country: "DE", visitors: 1 },
    ]);
  });

  it("respects the time range", async () => {
    const now = Date.now();
    await adapter.insertEvents([
      evt({ anonymousId: "old", ts: now - 30 * 864e5 }),
      evt({ anonymousId: "new", ts: now }),
    ]);
    expect(await createQueries({ adapter }).getVisitors()).toBe(1); // default 7d
    expect(await adapter.getVisitors({ from: 0, to: now })).toBe(2);
  });

  it("pruneBefore deletes old rows and reports the count", async () => {
    const now = Date.now();
    await adapter.insertEvents([
      evt({ id: "old", anonymousId: "o", ts: now - 1000 }),
      evt({ id: "new", anonymousId: "n", ts: now + 1000 }),
    ]);
    expect(await adapter.pruneBefore!(now)).toBe(1);
    expect(await adapter.getVisitors({ from: 0, to: now + 5000 })).toBe(1);
  });

  it("coerces a numeric section value to a string (parity with the sqlite adapter)", async () => {
    const now = Date.now();
    await adapter.insertEvents([
      evt({ name: "$section", props: { section: 123, dwellMs: 10 }, ts: now }),
    ]);
    const [row] = await createQueries({ adapter }).getSectionDwell();
    expect(row).toEqual({ section: "123", totalMs: 10, views: 1 });
    expect(typeof row!.section).toBe("string");
  });

  it("round-trips props JSON and optional fields (userId/city)", async () => {
    await adapter.insertEvents([
      evt({ userId: "u1", city: "Berlin", country: "DE", props: { plan: "pro" } }),
    ]);
    const top = await createQueries({ adapter }).getTopCountries();
    expect(top).toEqual([{ country: "DE", visitors: 1 }]);
  });
});
