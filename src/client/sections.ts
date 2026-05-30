import type { ClientConfig } from "../types";

type Track = (name: string, props?: Record<string, unknown>) => void;

export function startSectionObserver(cfg: Required<ClientConfig>, track: Track): void {
  if (typeof IntersectionObserver === "undefined") return;
  const enteredAt = new Map<Element, number>();

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const el = entry.target;
        const name = el.getAttribute(cfg.sectionAttribute) ?? "section";
        if (entry.isIntersecting) {
          enteredAt.set(el, performance.now());
        } else {
          const start = enteredAt.get(el);
          if (start != null) {
            enteredAt.delete(el);
            track("$section", { section: name, dwellMs: Math.round(performance.now() - start) });
          }
        }
      }
    },
    { threshold: 0.5 },
  );

  for (const el of document.querySelectorAll(`[${cfg.sectionAttribute}]`)) io.observe(el);
}
