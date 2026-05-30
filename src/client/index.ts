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
let preloadHide: (() => void) | undefined;
let teardownAutocapture: (() => void) | undefined;

// Events fired before the transport chunk finishes loading land here, then drain
// once it's ready. Keeping the batching machinery out of the synchronous bundle
// is what keeps the core tiny.
let pending: TinywatchEvent[] = [];

// Plugin teardowns (from setup() return values) and flush-error handlers
// registered via ctx.onFlushError before the transport chunk loads.
let pluginTeardowns: (() => void)[] = [];
let pendingErrorHandlers: ((events: TinywatchEvent[], error: unknown) => void)[] = [];

export function init(config: ClientConfig): void {
  if (cfg) return; // idempotent
  cfg = { ...DEFAULTS, ...config };

  // Safety net: if the page is closed before the transport chunk arrives, beacon
  // out whatever is buffered. Removed by shutdown().
  preloadHide = () => {
    if (document.visibilityState !== "hidden" || pending.length === 0 || transport) return;
    // Version inlined (not imported) so this path doesn't pull transport.ts into
    // the synchronous core bundle. Keep in sync with VERSION in transport.ts.
    navigator.sendBeacon?.(cfg!.endpoint, JSON.stringify({ events: pending, v: "0.1.0" }));
    pending = [];
  };
  addEventListener("visibilitychange", preloadHide);

  // Fire the first pageview on the critical path (it buffers into `pending`)...
  track("$pageview");

  // ...then load the transport + autocapture lazily so neither blocks first byte
  // nor lands in the synchronous core bundle. Capture cfg locally: if shutdown()
  // (or a re-init) swaps it out while these imports are in flight, the callbacks
  // must NOT build a transport against stale config — that would re-leak a timer
  // after teardown and read a cleared cfg.
  const c = cfg;
  void import("./transport").then(({ createTransport }) => {
    if (cfg !== c) return; // shut down (or re-inited) before the chunk loaded
    transport = createTransport(c.endpoint, c.flushInterval, c.batchSize);
    for (const h of pendingErrorHandlers) transport.onError(h);
    pendingErrorHandlers = [];
    for (const e of pending) transport.enqueue(e);
    pending = [];
  });

  if (c.autocapture) {
    void import("./autocapture").then(({ startAutocapture }) => {
      if (cfg !== c) return;
      teardownAutocapture = startAutocapture(c, track);
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

/**
 * Flush and tear down: clears the transport interval, removes all listeners
 * (transport, autocapture, sections) and restores the patched history methods,
 * then resets state so init() can run again. For SPA re-init, hot-reload, tests.
 *
 * Note: this also clears the identified user — re-identify after a re-init.
 */
export function shutdown(): void {
  if (preloadHide) removeEventListener("visibilitychange", preloadHide);
  transport?.shutdown();
  teardownAutocapture?.(); // removes click/scroll/popstate/section listeners, restores history
  for (const t of pluginTeardowns) t();
  preloadHide = transport = teardownAutocapture = knownUserId = cfg = undefined;
  pending = [];
  pluginTeardowns = [];
  pendingErrorHandlers = [];
}

export function use(plugin: Plugin): void {
  if (!cfg) throw new Error("tinywatch: init() before use()");
  const ctx: PluginContext = {
    track,
    // A copy so plugins can read config but can't mutate the client's live cfg
    // (autocapture reads cfg.* lazily per-event).
    config: { ...cfg },
    onFlushError(handler) {
      // Wire straight to the transport if it's loaded, else buffer until it is.
      if (transport) transport.onError(handler);
      else pendingErrorHandlers.push(handler);
    },
    reenqueue(events) {
      // Reuse the normal pending→drain path so ids/order are preserved and a
      // re-delivered event dedups server-side on its original id.
      if (transport) for (const e of events) transport.enqueue(e);
      else pending.push(...events);
    },
  };
  const teardown = plugin.setup(ctx);
  if (teardown) pluginTeardowns.push(teardown);
}

export type { ClientConfig, Plugin, PluginContext } from "../types";
