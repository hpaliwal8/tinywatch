import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSectionObserver } from "../src/client/sections";
import type { ClientConfig } from "../src/types";

// Drive IntersectionObserver and visibility manually, with a controllable clock,
// to assert dwell pauses while the tab is hidden.

type IOCallback = (entries: { target: Element; isIntersecting: boolean }[]) => void;

let ioCallback: IOCallback;
let now = 0;
let visibility: "visible" | "hidden" = "visible";
const visListeners = new Set<() => void>();

const el = { getAttribute: () => "hero" } as unknown as Element;

const cfg = {
  sectionAttribute: "data-tw-section",
} as Required<ClientConfig>;

beforeEach(() => {
  now = 0;
  visibility = "visible";
  visListeners.clear();

  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: IOCallback) {
        ioCallback = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("performance", { now: () => now });
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibility;
    },
    querySelectorAll: () => [el],
  });
  vi.stubGlobal("addEventListener", (type: string, fn: () => void) => {
    if (type === "visibilitychange") visListeners.add(fn);
  });
});
afterEach(() => vi.unstubAllGlobals());

function fireVisibility(state: "visible" | "hidden") {
  visibility = state;
  for (const fn of visListeners) fn();
}

describe("section dwell — visibility pausing", () => {
  it("does not count time while the tab is hidden", () => {
    const track = vi.fn();
    startSectionObserver(cfg, track);

    // Enter at t=0.
    ioCallback([{ target: el, isIntersecting: true }]);
    now = 1000; // 1s visible

    fireVisibility("hidden"); // pause clock at 1000
    now = 100000; // ~99s pass while hidden — must NOT count
    fireVisibility("visible"); // resume at 100000
    now = 100500; // +500ms visible

    // Leave the section -> emit.
    ioCallback([{ target: el, isIntersecting: false }]);

    expect(track).toHaveBeenCalledTimes(1);
    const [name, props] = track.mock.calls[0]!;
    expect(name).toBe("$section");
    // 1000ms (before hide) + 500ms (after show) = 1500ms; hidden time excluded.
    expect(props.dwellMs).toBe(1500);
    expect(props.section).toBe("hero");
  });

  it("counts continuous visible dwell normally", () => {
    const track = vi.fn();
    startSectionObserver(cfg, track);
    ioCallback([{ target: el, isIntersecting: true }]);
    now = 2500;
    ioCallback([{ target: el, isIntersecting: false }]);
    expect(track.mock.calls[0]![1].dwellMs).toBe(2500);
  });
});
