import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTransport } from "../src/client/transport";
import type { TinywatchEvent } from "../src/types";

// Verifies the failure seam added for the retry plugin: a rejected fetch should
// surface the failed events to registered onError handlers.

const ev = (id: string): TinywatchEvent & { id: string } => ({
  name: "$x",
  anonymousId: "a",
  sessionId: "s",
  path: "/",
  ts: 0,
  id,
});

beforeEach(() => {
  vi.stubGlobal("navigator", {}); // no sendBeacon -> always use fetch
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("removeEventListener", () => {});
});
afterEach(() => vi.unstubAllGlobals());

describe("transport onError", () => {
  it("calls handlers with the failed events when fetch rejects", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const t = createTransport("/api/tw", 999999, 100);
    const failed: TinywatchEvent[][] = [];
    t.onError((events) => failed.push(events));

    t.enqueue(ev("e1"));
    t.enqueue(ev("e2"));
    t.flush();

    await Promise.resolve(); // let the rejected fetch settle
    await Promise.resolve();

    expect(failed).toHaveLength(1);
    expect(failed[0]!.map((e) => (e as unknown as { id: string }).id)).toEqual(["e1", "e2"]);
    t.shutdown();
  });

  it("does NOT call onError on a successful flush", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("{}")));
    const t = createTransport("/api/tw", 999999, 100);
    const failed: TinywatchEvent[][] = [];
    t.onError((events) => failed.push(events));

    t.enqueue(ev("ok"));
    t.flush();
    await Promise.resolve();
    await Promise.resolve();

    expect(failed).toHaveLength(0);
    t.shutdown();
  });

  it("uses sendBeacon (not fetch, no onError) on a beacon flush", () => {
    const beacons: string[] = [];
    vi.stubGlobal("navigator", { sendBeacon: (_u: string, b: string) => (beacons.push(b), true) });
    vi.stubGlobal("fetch", () => Promise.reject(new Error("should not be called")));
    const t = createTransport("/api/tw", 999999, 100);
    const failed: unknown[] = [];
    t.onError(() => failed.push(1));

    t.enqueue(ev("b1"));
    t.flush(true); // beacon path

    expect(beacons).toHaveLength(1);
    expect(failed).toHaveLength(0); // beacon failures aren't surfaced
    t.shutdown();
  });

  it("a throwing handler does not starve other handlers", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const t = createTransport("/api/tw", 999999, 100);
    const ran: string[] = [];
    t.onError(() => {
      throw new Error("bad plugin");
    });
    t.onError(() => ran.push("second"));

    t.enqueue(ev("e1"));
    t.flush();
    await Promise.resolve();
    await Promise.resolve();

    expect(ran).toEqual(["second"]); // second handler still ran
    t.shutdown();
  });

  it("does not surface a fetch that rejects AFTER shutdown()", async () => {
    let reject!: (e: unknown) => void;
    vi.stubGlobal("fetch", () => new Promise((_res, rej) => (reject = rej)));
    const t = createTransport("/api/tw", 999999, 100);
    const failed: unknown[] = [];
    t.onError(() => failed.push(1));

    t.enqueue(ev("e1"));
    t.flush(); // fetch is now pending
    t.shutdown(); // tear down before it settles
    reject(new Error("offline")); // late rejection
    await Promise.resolve();
    await Promise.resolve();

    expect(failed).toHaveLength(0); // not surfaced post-shutdown
  });
});
