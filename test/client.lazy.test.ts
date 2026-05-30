import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventBatch } from "../src/types";

// The client core touches a handful of browser globals. Rather than pull in
// jsdom, stub exactly what init/track/transport reach for. A single shared
// listener registry lets the test dispatch "visibilitychange" to force a flush.

interface Stubs {
  beaconCalls: { url: string; body: string }[];
  fetchCalls: { url: string; body: string }[];
  fireVisibility: (state: "visible" | "hidden") => void;
  listenerCount: (type: string) => number;
  clearedTimers: () => number;
}

function installDomStubs(): Stubs {
  const listeners = new Map<string, Set<(e?: unknown) => void>>();
  const beaconCalls: Stubs["beaconCalls"] = [];
  const fetchCalls: Stubs["fetchCalls"] = [];
  const store = new Map<string, string>();
  let visibility: "visible" | "hidden" = "visible";
  let cleared = 0;

  vi.stubGlobal("addEventListener", (type: string, fn: (e?: unknown) => void) => {
    (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn);
  });
  vi.stubGlobal("removeEventListener", (type: string, fn: (e?: unknown) => void) => {
    listeners.get(type)?.delete(fn);
  });
  // Track clearInterval calls so we can assert teardown. Capture the real impl
  // first — stubGlobal replaces the global, so referencing clearInterval inside
  // would recurse into the stub.
  const realClearInterval = clearInterval;
  vi.stubGlobal("clearInterval", (id: ReturnType<typeof setInterval>) => {
    cleared++;
    realClearInterval(id);
  });
  vi.stubGlobal("location", { pathname: "/test" });
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibility;
    },
  });
  vi.stubGlobal("navigator", {
    sendBeacon: (url: string, body: string) => {
      beaconCalls.push({ url, body });
      return true;
    },
  });
  vi.stubGlobal("fetch", (url: string, init: { body: string }) => {
    fetchCalls.push({ url, body: init.body });
    return Promise.resolve(new Response("{}"));
  });

  return {
    beaconCalls,
    fetchCalls,
    fireVisibility(state) {
      visibility = state;
      for (const fn of listeners.get("visibilitychange") ?? []) fn();
    },
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
    clearedTimers: () => cleared,
  };
}

// Re-import the module fresh per test so its module-level state (cfg, pending,
// transport) doesn't leak between cases.
let current: typeof import("../src/client/index") | undefined;
async function freshClient() {
  vi.resetModules();
  current = await import("../src/client/index");
  return current;
}

let stubs: Stubs;

beforeEach(() => {
  stubs = installDomStubs();
});

afterEach(async () => {
  // Tear down this test's client so its interval/listeners can't bleed into the
  // next test, then drain in-flight dynamic imports *while the stubs still
  // exist*. Combined, a straggling import hits cfg===undefined and the product's
  // `cfg !== c` guard makes it a harmless no-op — deterministic, not tick-racing.
  current?.shutdown();
  current = undefined;
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  vi.unstubAllGlobals();
});

describe("client lazy-load + buffering (the 3b behavior)", () => {
  it("track() before init() is a no-op and does not throw", async () => {
    const { track } = await freshClient();
    expect(() => track("early")).not.toThrow();
    stubs.fireVisibility("hidden");
    expect(stubs.beaconCalls).toHaveLength(0);
    expect(stubs.fetchCalls).toHaveLength(0);
  });

  it("buffers events fired before the transport chunk loads, then flushes them", async () => {
    const { init, track } = await freshClient();
    init({ endpoint: "/api/tw", autocapture: false });
    track("custom_event", { foo: 1 });

    // Let the dynamic import("./transport") resolve.
    await vi.waitFor(() => {
      stubs.fireVisibility("hidden"); // transport flush(true) -> sendBeacon
      expect(stubs.beaconCalls.length).toBeGreaterThan(0);
    });

    const sent = stubs.beaconCalls.flatMap((c) => (JSON.parse(c.body) as EventBatch).events);
    const names = sent.map((e) => e.name);
    expect(names).toContain("$pageview"); // fired by init()
    expect(names).toContain("custom_event");
    expect(sent.every((e) => typeof e.anonymousId === "string")).toBe(true);
  });

  it("the pre-load safety net beacons buffered events if hidden before transport arrives", async () => {
    const { init } = await freshClient();
    init({ endpoint: "/api/tw", autocapture: false });
    // Fire hidden synchronously, before awaiting the dynamic import.
    stubs.fireVisibility("hidden");

    expect(stubs.beaconCalls.length).toBeGreaterThan(0);
    const events = (JSON.parse(stubs.beaconCalls[0]!.body) as EventBatch).events;
    expect(events.map((e) => e.name)).toContain("$pageview");
  });

  it("init() is idempotent — a second call does not re-fire pageview", async () => {
    const { init } = await freshClient();
    init({ endpoint: "/api/tw", autocapture: false });
    init({ endpoint: "/other", autocapture: false });

    await vi.waitFor(() => {
      stubs.fireVisibility("hidden");
      expect(stubs.beaconCalls.length).toBeGreaterThan(0);
    });
    const sent = stubs.beaconCalls.flatMap((c) => (JSON.parse(c.body) as EventBatch).events);
    expect(sent.filter((e) => e.name === "$pageview")).toHaveLength(1);
    // All beacons went to the first endpoint; the second init() was ignored.
    expect(stubs.beaconCalls.every((c) => c.url === "/api/tw")).toBe(true);
  });
});

describe("shutdown()", () => {
  it("clears the transport interval and removes its listeners", async () => {
    const { init, shutdown } = await freshClient();
    init({ endpoint: "/api/tw", autocapture: false });
    // Wait until THIS test's transport has loaded. The transport registers a
    // SECOND beforeunload listener on top of nothing (the core uses only
    // visibilitychange), so beforeunload count going from 0 -> 1 is a transport-
    // only signal; the afterEach drain prevents a prior test's import bleeding in.
    await vi.waitFor(() => expect(stubs.listenerCount("beforeunload")).toBe(1));

    shutdown();

    expect(stubs.clearedTimers()).toBe(1); // the transport interval was cleared
    expect(stubs.listenerCount("beforeunload")).toBe(0);
    expect(stubs.listenerCount("visibilitychange")).toBe(0); // transport + core onHide both removed
  });

  it("does a final flush on shutdown", async () => {
    const { init, track, shutdown } = await freshClient();
    init({ endpoint: "/api/tw", autocapture: false });
    await vi.waitFor(() => expect(stubs.listenerCount("beforeunload")).toBeGreaterThan(0));
    track("late_event");
    shutdown();
    // shutdown() -> transport.shutdown() -> flush(true) -> sendBeacon
    const sent = stubs.beaconCalls.flatMap((c) => (JSON.parse(c.body) as EventBatch).events);
    expect(sent.map((e) => e.name)).toContain("late_event");
  });

  it("resets state so init() can run again (re-init fires a fresh pageview)", async () => {
    const client = await freshClient();
    client.init({ endpoint: "/api/tw", autocapture: false });
    await vi.waitFor(() => expect(stubs.listenerCount("beforeunload")).toBeGreaterThan(0));
    client.shutdown();

    // A fresh init after shutdown is NOT a no-op (cfg was reset).
    client.init({ endpoint: "/second", autocapture: false });
    await vi.waitFor(() => {
      stubs.fireVisibility("hidden");
      expect(stubs.beaconCalls.some((c) => c.url === "/second")).toBe(true);
    });
    const second = stubs.beaconCalls.filter((c) => c.url === "/second");
    const names = second.flatMap((c) => (JSON.parse(c.body) as EventBatch).events.map((e) => e.name));
    expect(names).toContain("$pageview");
  });

  it("track() after shutdown is a no-op (not initialized)", async () => {
    const { init, track, shutdown } = await freshClient();
    init({ endpoint: "/api/tw", autocapture: false });
    await vi.waitFor(() => expect(stubs.listenerCount("beforeunload")).toBeGreaterThan(0));
    shutdown();
    stubs.beaconCalls.length = 0;
    stubs.fetchCalls.length = 0;
    track("after_shutdown");
    stubs.fireVisibility("hidden");
    const sent = [...stubs.beaconCalls, ...stubs.fetchCalls].flatMap(
      (c) => (JSON.parse(c.body) as EventBatch).events,
    );
    expect(sent.map((e) => e.name)).not.toContain("after_shutdown");
  });
});

describe("use() plugins", () => {
  it("throws if called before init()", async () => {
    const { use } = await freshClient();
    expect(() => use({ name: "p", setup() {} })).toThrow(/init\(\) before use\(\)/);
  });

  it("runs the plugin and exposes track + config", async () => {
    const { init, use } = await freshClient();
    init({ endpoint: "/api/tw", autocapture: false });
    let seenEndpoint: string | undefined;
    use({
      name: "p",
      setup(ctx) {
        seenEndpoint = ctx.config.endpoint;
        ctx.track("from_plugin");
      },
    });
    expect(seenEndpoint).toBe("/api/tw");
    await vi.waitFor(() => {
      stubs.fireVisibility("hidden");
      expect(stubs.beaconCalls.length).toBeGreaterThan(0);
    });
    const sent = stubs.beaconCalls.flatMap((c) => (JSON.parse(c.body) as EventBatch).events);
    expect(sent.map((e) => e.name)).toContain("from_plugin");
  });

  it("gives plugins a config copy — mutating it does not affect the client", async () => {
    const { init, use, track } = await freshClient();
    init({ endpoint: "/api/tw", autocapture: false });
    use({
      name: "evil",
      setup(ctx) {
        // A plugin tampering with config must not change the live client.
        (ctx.config as { endpoint: string }).endpoint = "https://evil.test";
      },
    });
    track("after_plugin");
    await vi.waitFor(() => {
      stubs.fireVisibility("hidden");
      expect(stubs.beaconCalls.length).toBeGreaterThan(0);
    });
    // All events still flush to the original endpoint, not the mutated one.
    expect(stubs.beaconCalls.every((c) => c.url === "/api/tw")).toBe(true);
  });

  it("calls a plugin's returned teardown on shutdown()", async () => {
    const { init, use, shutdown } = await freshClient();
    init({ endpoint: "/api/tw", autocapture: false });
    const teardown = vi.fn();
    use({ name: "p", setup: () => teardown });
    expect(teardown).not.toHaveBeenCalled();
    shutdown();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("onFlushError registered before transport loads still fires on a failed flush", async () => {
    // fetch rejects so the (non-beacon) interval/batch flush surfaces an error.
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const { init, track, use } = await freshClient();
    const failed: string[] = [];
    init({ endpoint: "/api/tw", autocapture: false, batchSize: 1 });
    // use() runs before the transport chunk resolves -> handler is buffered.
    use({
      name: "catcher",
      setup(ctx) {
        ctx.onFlushError((events) => failed.push(...events.map((e) => e.name)));
      },
    });
    track("will_fail"); // batchSize 1 -> eager flush once transport loads
    await vi.waitFor(() => expect(failed).toContain("will_fail"));
  });
});
