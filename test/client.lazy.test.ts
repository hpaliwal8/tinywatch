import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventBatch } from "../src/types";

// The client core touches a handful of browser globals. Rather than pull in
// jsdom, stub exactly what init/track/transport reach for. A single shared
// listener registry lets the test dispatch "visibilitychange" to force a flush.

interface Stubs {
  beaconCalls: { url: string; body: string }[];
  fetchCalls: { url: string; body: string }[];
  fireVisibility: (state: "visible" | "hidden") => void;
}

function installDomStubs(): Stubs {
  const listeners = new Map<string, Set<(e?: unknown) => void>>();
  const beaconCalls: Stubs["beaconCalls"] = [];
  const fetchCalls: Stubs["fetchCalls"] = [];
  const store = new Map<string, string>();
  let visibility: "visible" | "hidden" = "visible";

  vi.stubGlobal("addEventListener", (type: string, fn: (e?: unknown) => void) => {
    (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn);
  });
  vi.stubGlobal("location", { pathname: "/test" });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
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
  };
}

// Re-import the module fresh per test so its module-level state (cfg, pending,
// transport) doesn't leak between cases.
async function freshClient() {
  vi.resetModules();
  return import("../src/client/index");
}

let stubs: Stubs;

beforeEach(() => {
  stubs = installDomStubs();
});

afterEach(async () => {
  // Let any in-flight dynamic import("./transport") resolve *while the global
  // stubs still exist*, otherwise createTransport runs post-teardown and throws
  // an unhandled rejection referencing the removed addEventListener.
  await new Promise((r) => setTimeout(r, 0));
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
