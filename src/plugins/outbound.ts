import type { Plugin, PluginContext } from "../types";

export interface OutboundOptions {
  /** Event name emitted for an outbound click. Default "$outbound". */
  eventName?: string;
  /** Treat these hostnames as internal (in addition to the current origin). */
  internalHosts?: string[];
}

/**
 * Tracks clicks on links that leave the current site. Registers one delegated
 * click listener and emits `ctx.track(eventName, { href, text })` for any anchor
 * whose host isn't the current origin (or an explicitly internal host).
 *
 * Uses only the Plugin contract's `track` — no special hooks — so it works with
 * the stock client:
 *
 *   import { init, use } from "tinywatch";
 *   import { outbound } from "tinywatch/plugins/outbound";
 *   init({ endpoint: "/api/tw" });
 *   use(outbound());
 */
export function outbound(opts: OutboundOptions = {}): Plugin {
  const eventName = opts.eventName ?? "$outbound";
  const internal = new Set(opts.internalHosts ?? []);

  return {
    name: "outbound",
    setup({ track }: PluginContext) {
      if (typeof document === "undefined") return; // non-browser host: no-op

      document.addEventListener("click", (e) => {
        const a = (e.target as Element | null)?.closest("a");
        const href = a?.getAttribute("href");
        if (!a || !href) return;

        let url: URL;
        try {
          url = new URL(href, location.href);
        } catch {
          return; // not a resolvable URL (e.g. "#", "javascript:")
        }
        // Only http(s) links to a different host count as outbound.
        if (url.protocol !== "http:" && url.protocol !== "https:") return;
        if (url.host === location.host || internal.has(url.host)) return;

        track(eventName, {
          href: url.href,
          text: (a.textContent ?? "").trim().slice(0, 120),
        });
      });
    },
  };
}
