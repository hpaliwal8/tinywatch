import type { ClientConfig } from "../types";

type Track = (name: string, props?: Record<string, unknown>) => void;

export function startAutocapture(cfg: Required<ClientConfig>, track: Track): void {
  // Clicks via event delegation on [data-tw-track].
  document.addEventListener("click", (e) => {
    const el = (e.target as Element | null)?.closest(`[${cfg.trackAttribute}]`);
    if (!el) return;
    const label = el.getAttribute(cfg.trackAttribute);
    track(label ? label : "$click", {
      text: (el.textContent ?? "").trim().slice(0, 120),
      tag: el.tagName.toLowerCase(),
    });
  });

  // SPA pageviews: patch History + listen for popstate.
  patchHistory(() => track("$pageview"));
  addEventListener("popstate", () => track("$pageview"));

  // Scroll depth milestones.
  trackScrollDepth(track);

  // Section dwell (loaded with autocapture so it's also off the critical path).
  void import("./sections").then(({ startSectionObserver }) => {
    startSectionObserver(cfg, track);
  });
}

function patchHistory(onChange: () => void): void {
  for (const m of ["pushState", "replaceState"] as const) {
    const orig = history[m];
    history[m] = function (this: History, ...args: Parameters<History["pushState"]>) {
      const r = orig.apply(this, args);
      onChange();
      return r;
    };
  }
}

function trackScrollDepth(track: Track): void {
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
    { passive: true },
  );
}
