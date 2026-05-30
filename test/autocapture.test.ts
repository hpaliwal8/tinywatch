import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAutocapture } from "../src/client/autocapture";
import type { ClientConfig } from "../src/types";

// Targeted DOM stubs for autocapture: a listener registry that honors the
// AbortController `signal` (so teardown is observable), plus history with
// patchable pushState/replaceState.

interface Reg {
  fire: (type: string, ev?: unknown) => void;
  count: (type: string) => number;
}

function installDom(): Reg {
  const listeners = new Map<string, Set<(e?: unknown) => void>>();
  const add = (target: string) =>
    function (this: unknown, type: string, fn: (e?: unknown) => void, opts?: { signal?: AbortSignal }) {
      const key = `${target}:${type}`;
      const set = listeners.get(key) ?? listeners.set(key, new Set()).get(key)!;
      set.add(fn);
      opts?.signal?.addEventListener("abort", () => set.delete(fn));
    };

  vi.stubGlobal("addEventListener", add("win"));
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: add("doc"),
    querySelectorAll: () => [] as Element[],
    documentElement: { scrollTop: 0, clientHeight: 0, scrollHeight: 0 },
  });
  const realPush = () => "real-push";
  const realReplace = () => "real-replace";
  vi.stubGlobal("history", { pushState: realPush, replaceState: realReplace });
  vi.stubGlobal("performance", { now: () => 0 });
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    disconnect() {}
  });

  return {
    fire(type, ev) {
      for (const fn of listeners.get(type) ?? []) fn(ev);
    },
    count: (type) => listeners.get(type)?.size ?? 0,
  };
}

const cfg = {
  trackAttribute: "data-tw-track",
  sectionAttribute: "data-tw-section",
} as Required<ClientConfig>;

let dom: Reg;
beforeEach(() => {
  dom = installDom();
});
afterEach(() => vi.unstubAllGlobals());

describe("autocapture teardown", () => {
  it("removes all listeners on teardown", () => {
    const track = vi.fn();
    const teardown = startAutocapture(cfg, track);

    expect(dom.count("doc:click")).toBe(1);
    expect(dom.count("win:popstate")).toBe(1);
    expect(dom.count("win:scroll")).toBe(1);

    teardown();

    expect(dom.count("doc:click")).toBe(0);
    expect(dom.count("win:popstate")).toBe(0);
    expect(dom.count("win:scroll")).toBe(0);
  });

  it("restores history.pushState/replaceState on teardown", () => {
    const before = history.pushState;
    const teardown = startAutocapture(cfg, vi.fn());
    expect(history.pushState).not.toBe(before); // patched
    teardown();
    expect(history.pushState).toBe(before); // restored
    expect(history.replaceState({}, "", "/x")).toBe("real-replace"); // original behavior back
  });

  it("does not double-fire $pageview after start→teardown→start (re-init)", () => {
    const track = vi.fn();
    const t1 = startAutocapture(cfg, track);
    t1();
    const t2 = startAutocapture(cfg, track);

    // A single pushState should fire exactly one $pageview, not two.
    history.pushState({}, "", "/next");
    const pageviews = track.mock.calls.filter(([n]) => n === "$pageview");
    expect(pageviews).toHaveLength(1);

    t2();
  });

  it("does not double-fire $click after re-init (one click = one event)", () => {
    const track = vi.fn();
    startAutocapture(cfg, track)(); // start then immediately tear down
    const t2 = startAutocapture(cfg, track);

    // Simulate a click on a tracked element.
    const el = {
      closest: () => ({
        getAttribute: () => "signup",
        textContent: "Sign up",
        tagName: "BUTTON",
      }),
    };
    dom.fire("doc:click", { target: el });

    expect(track.mock.calls.filter(([n]) => n === "signup")).toHaveLength(1);
    t2();
  });
});
