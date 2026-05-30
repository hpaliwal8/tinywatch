import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Minimal Storage stub backed by a Map.
function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

async function freshIds() {
  vi.resetModules();
  return import("../src/client/ids");
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memStorage());
  vi.stubGlobal("sessionStorage", memStorage());
});
afterEach(() => vi.unstubAllGlobals());

describe("getSessionId — persisted across page loads", () => {
  it("returns the same id from sessionStorage within the timeout", async () => {
    const ids = await freshIds();
    const first = ids.getSessionId();

    // Simulate a fresh page load: module state reset, but sessionStorage persists.
    const ids2 = await freshIds();
    const second = ids2.getSessionId();

    expect(second).toBe(first); // survived the "navigation"
  });

  it("mints a new id once the inactivity timeout has elapsed", async () => {
    const ids = await freshIds();
    const first = ids.getSessionId();

    // Backdate the stored `last` beyond the 30-min timeout.
    const stored = JSON.parse(sessionStorage.getItem("tw_session")!);
    stored.last = Date.now() - 31 * 60 * 1000;
    sessionStorage.setItem("tw_session", JSON.stringify(stored));

    const ids2 = await freshIds();
    expect(ids2.getSessionId()).not.toBe(first);
  });

  it("rejects a malformed stored record (non-string id) and mints a fresh valid one", async () => {
    // A third-party script or stale schema could write a record with a recent
    // `last` but a non-string `id`. Without shape validation this would yield a
    // numeric sessionId that the server silently drops.
    sessionStorage.setItem("tw_session", JSON.stringify({ id: 123, last: Date.now() }));
    const ids = await freshIds();
    const id = ids.getSessionId();
    expect(typeof id).toBe("string");
    expect(id).not.toBe("123");
  });

  it("falls back to memory when sessionStorage throws (private mode)", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    const ids = await freshIds();
    const a = ids.getSessionId();
    const b = ids.getSessionId();
    expect(a).toBe(b); // stable within the page via memSession
    expect(typeof a).toBe("string");
  });
});

describe("getAnonymousId", () => {
  it("persists in localStorage and is stable across calls", async () => {
    const ids = await freshIds();
    const a = ids.getAnonymousId(true);
    const b = ids.getAnonymousId(true);
    expect(a).toBe(b);
    expect(localStorage.getItem("tw_anon")).toBe(a);
  });

  it("stays in memory only when persist is false", async () => {
    const ids = await freshIds();
    const a = ids.getAnonymousId(false);
    expect(a).toBe(ids.getAnonymousId(false));
    expect(localStorage.getItem("tw_anon")).toBeNull();
  });
});
