import type { EventBatch, TinywatchEvent } from "../types";

const VERSION = "0.1.0";

type ErrorHandler = (events: TinywatchEvent[], error: unknown) => void;

export interface Transport {
  enqueue(event: TinywatchEvent): void;
  flush(useBeacon?: boolean): void;
  /** Register a handler for failed (non-beacon) flushes. */
  onError(handler: ErrorHandler): void;
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
  let dead = false;
  const errorHandlers: ErrorHandler[] = [];

  function flush(useBeacon = false): void {
    if (buf.length === 0) return;
    const sent = buf;
    buf = [];
    const body = JSON.stringify({ events: sent, v: VERSION } satisfies EventBatch);

    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(endpoint, body);
      return;
    }
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch((err: unknown) => {
      // Don't surface failures once shut down (a late-rejecting fetch would
      // otherwise schedule a retry against a torn-down client). One handler
      // throwing must not starve the others.
      if (dead) return;
      for (const h of errorHandlers) {
        try {
          h(sent, err);
        } catch {
          // a misbehaving plugin handler shouldn't break the others
        }
      }
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
    onError(handler: ErrorHandler): void {
      errorHandlers.push(handler);
    },
    shutdown(): void {
      flush(true);
      dead = true; // ignore any in-flight fetch that rejects after this
      clearInterval(timer);
      if (canListen) {
        removeEventListener("beforeunload", onUnload);
        removeEventListener("visibilitychange", onVisibility);
      }
    },
  };
}
