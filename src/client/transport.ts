import type { EventBatch, TinywatchEvent } from "../types";

const VERSION = "0.1.0";

export interface Transport {
  enqueue(event: TinywatchEvent): void;
  flush(useBeacon?: boolean): void;
  /** Final flush, clear the interval, and remove listeners. */
  shutdown(): void;
}

/**
 * Batching sink for events. A closure (not a class) so the minifier can rename
 * every local to a single letter — `this.buf` can't be shortened, `buf` can.
 * Lazy-loaded from init() so none of this lands in the synchronous core bundle.
 */
export function createTransport(
  endpoint: string,
  flushInterval: number,
  batchSize: number,
): Transport {
  let buf: TinywatchEvent[] = [];

  function flush(useBeacon = false): void {
    if (buf.length === 0) return;
    const batch: EventBatch = { events: buf, v: VERSION };
    buf = [];
    const body = JSON.stringify(batch);

    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(endpoint, body);
      return;
    }
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {
      // Best-effort. TODO: optional retry/backoff as a plugin, not in core.
    });
  }

  const timer = setInterval(() => flush(), flushInterval);
  const onUnload = () => flush(true);
  // visibilitychange is more reliable than beforeunload on mobile.
  const onVisibility = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") flush(true);
  };
  // Guard for non-browser hosts (SSR, tests, workers without these globals):
  // wiring up listeners is best-effort, so the transport degrades to a plain
  // interval+manual-flush sink rather than throwing at construction time.
  const canListen = typeof addEventListener === "function";
  if (canListen) {
    addEventListener("beforeunload", onUnload);
    addEventListener("visibilitychange", onVisibility);
  }

  return {
    enqueue(event: TinywatchEvent): void {
      buf.push(event);
      if (buf.length >= batchSize) flush();
    },
    flush,
    shutdown(): void {
      flush(true);
      clearInterval(timer);
      if (canListen) {
        removeEventListener("beforeunload", onUnload);
        removeEventListener("visibilitychange", onVisibility);
      }
    },
  };
}
