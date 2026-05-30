import type { ClientConfig, Plugin, PluginContext, TinywatchEvent } from "../types";
import { getAnonymousId, getSessionId } from "./ids";
import type { Transport } from "./transport";

const DEFAULTS = {
  autocapture: true,
  flushInterval: 5000,
  batchSize: 30,
  trackAttribute: "data-tw-track",
  sectionAttribute: "data-tw-section",
  noPersist: false,
} satisfies Omit<Required<ClientConfig>, "endpoint">;

let cfg: Required<ClientConfig> | undefined;
let transport: Transport | undefined;
let knownUserId: string | undefined;

// Events fired before the transport chunk finishes loading land here, then drain
// once it's ready. Keeping the batching machinery out of the synchronous bundle
// is what keeps the core tiny.
let pending: TinywatchEvent[] = [];

export function init(config: ClientConfig): void {
  if (cfg) return; // idempotent
  cfg = { ...DEFAULTS, ...config };

  // Safety net: if the page is closed before the transport chunk arrives, beacon
  // out whatever is buffered. Removed once the real transport takes over flushing.
  const onHide = () => {
    if (pending.length === 0 || transport) return;
    // Version inlined (not imported) so this path doesn't pull transport.ts into
    // the synchronous core bundle. Keep in sync with VERSION in transport.ts.
    navigator.sendBeacon?.(cfg!.endpoint, JSON.stringify({ events: pending, v: "0.1.0" }));
    pending = [];
  };
  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") onHide();
  });

  // Fire the first pageview on the critical path (it buffers into `pending`)...
  track("$pageview");

  // ...then load the transport + autocapture lazily so neither blocks first byte
  // nor lands in the synchronous core bundle.
  void import("./transport").then(({ createTransport }) => {
    transport = createTransport(cfg!.endpoint, cfg!.flushInterval, cfg!.batchSize);
    for (const e of pending) transport.enqueue(e);
    pending = [];
  });

  if (cfg.autocapture) {
    void import("./autocapture").then(({ startAutocapture }) => {
      startAutocapture(cfg!, track);
    });
  }
}

export function track(name: string, props?: Record<string, unknown>): void {
  if (!cfg) return; // not initialized — no-op
  const event: TinywatchEvent = {
    name,
    anonymousId: getAnonymousId(!cfg.noPersist),
    userId: knownUserId,
    sessionId: getSessionId(),
    path: location.pathname,
    props,
    ts: Date.now(),
  };
  if (transport) transport.enqueue(event);
  else pending.push(event);
}

export function identify(userId: string): void {
  knownUserId = userId;
}

export function use(plugin: Plugin): void {
  if (!cfg) throw new Error("tinywatch: call init() before use()");
  const ctx: PluginContext = { track, config: cfg };
  plugin.setup(ctx);
}

/** Convenience namespace for `tw.use(...)` ergonomics. */
export const tw = { init, track, identify, use };

export type { ClientConfig, Plugin, PluginContext } from "../types";
