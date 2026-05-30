import type { ClientConfig } from "../types";

type Track = (name: string, props?: Record<string, unknown>) => void;

export function startSectionObserver(cfg: Required<ClientConfig>, track: Track): void {
  if (typeof IntersectionObserver === "undefined") return;

  // Per-element dwell state. `accrued` holds time banked before the current run;
  // `runStart` is when the current run began, or null while the tab is hidden.
  // Splitting the two lets us pause the clock when backgrounded instead of
  // counting away-time toward dwell.
  const state = new Map<Element, { accrued: number; runStart: number | null }>();

  function elapsed(s: { accrued: number; runStart: number | null }): number {
    return s.accrued + (s.runStart == null ? 0 : performance.now() - s.runStart);
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const el = entry.target;
        if (entry.isIntersecting) {
          // Only start the clock if the tab is currently visible.
          const visible = document.visibilityState !== "hidden";
          state.set(el, { accrued: 0, runStart: visible ? performance.now() : null });
        } else {
          const s = state.get(el);
          if (s) {
            state.delete(el);
            const name = el.getAttribute(cfg.sectionAttribute) ?? "section";
            track("$section", { section: name, dwellMs: Math.round(elapsed(s)) });
          }
        }
      }
    },
    { threshold: 0.5 },
  );

  // Pause the dwell clock while the tab is hidden, resume on return — so a
  // backgrounded tab doesn't inflate dwell with time the section wasn't viewed.
  addEventListener("visibilitychange", () => {
    const hidden = document.visibilityState === "hidden";
    for (const [, s] of state) {
      if (hidden && s.runStart != null) {
        s.accrued += performance.now() - s.runStart;
        s.runStart = null;
      } else if (!hidden && s.runStart == null) {
        s.runStart = performance.now();
      }
    }
  });

  for (const el of document.querySelectorAll(`[${cfg.sectionAttribute}]`)) io.observe(el);
}
