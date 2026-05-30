import type { ClientConfig } from "../types";

type Track = (name: string, props?: Record<string, unknown>) => void;
export type Teardown = () => void;

// Marker so a second startAutocapture (e.g. after shutdown + re-init) doesn't
// wrap history.pushState on top of an already-patched one.
interface PatchedHistory extends History {
  __twUnpatch?: Teardown;
}

export function startAutocapture(cfg: Required<ClientConfig>, track: Track): Teardown {
  // One AbortController removes every listener registered below in a single call.
  const ac = new AbortController();
  const { signal } = ac;

  // Clicks via event delegation on [data-tw-track].
  document.addEventListener(
    "click",
    (e) => {
      const el = (e.target as Element | null)?.closest(`[${cfg.trackAttribute}]`);
      if (!el) return;
      const label = el.getAttribute(cfg.trackAttribute);
      track(label ? label : "$click", {
        text: (el.textContent ?? "").trim().slice(0, 120),
        tag: el.tagName.toLowerCase(),
      });
    },
    { signal },
  );

  // SPA pageviews: patch History + listen for popstate.
  const unpatchHistory = patchHistory(() => track("$pageview"));
  addEventListener("popstate", () => track("$pageview"), { signal });

  // Scroll depth milestones.
  trackScrollDepth(track, signal);

  // Section dwell (loaded with autocapture so it's also off the critical path).
  let teardownSections: Teardown | undefined;
  void import("./sections").then(({ startSectionObserver }) => {
    // If we were already torn down before the chunk loaded, don't start.
    if (signal.aborted) return;
    teardownSections = startSectionObserver(cfg, track);
  });

  return () => {
    ac.abort();
    unpatchHistory();
    teardownSections?.();
  };
}

function patchHistory(onChange: () => void): Teardown {
  const h = history as PatchedHistory;
  // Already patched (prior init cycle that wasn't torn down): reuse its unpatch.
  if (h.__twUnpatch) return h.__twUnpatch;

  const originals = { pushState: history.pushState, replaceState: history.replaceState };
  for (const m of ["pushState", "replaceState"] as const) {
    const orig = originals[m];
    history[m] = function (this: History, ...args: Parameters<History["pushState"]>) {
      const r = orig.apply(this, args);
      onChange();
      return r;
    };
  }
  const unpatch: Teardown = () => {
    history.pushState = originals.pushState;
    history.replaceState = originals.replaceState;
    delete h.__twUnpatch;
  };
  h.__twUnpatch = unpatch;
  return unpatch;
}

function trackScrollDepth(track: Track, signal: AbortSignal): void {
  const seen = new Set<number>();
  addEventListener(
    "scroll",
    () => {
      const h = document.documentElement;
      // Guard non-scrollable / zero-height docs: scrollHeight <= clientHeight
      // means there's nothing to scroll, so avoid NaN (0/0) and bogus 100% fires.
      if (h.scrollHeight <= h.clientHeight) return;
      const pct = Math.min(100, Math.round(((h.scrollTop + h.clientHeight) / h.scrollHeight) * 100));
      for (const mark of [25, 50, 75, 100]) {
        if (pct >= mark && !seen.has(mark)) {
          seen.add(mark);
          track("$scroll", { depth: mark });
        }
      }
    },
    { passive: true, signal },
  );
}
