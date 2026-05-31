import type { Plugin, PluginContext, TinywatchEvent } from "../types";

export interface RetryOptions {
  /** Max re-delivery attempts per batch before dropping it. Default 5. */
  maxRetries?: number;
  /** Base backoff in ms; doubles each attempt (capped at maxDelay). Default 1000. */
  baseDelay?: number;
  /** Upper bound on a single backoff delay (ms). Default 30000. */
  maxDelay?: number;
}

/**
 * Re-delivers events whose flush failed, with exponential backoff and a per-batch
 * attempt cap (so a dead endpoint can't accumulate events forever). Re-enqueued
 * events keep their original ids, so a retried-then-delivered event dedups
 * server-side rather than double-counting.
 *
 *   import { init, use } from "@hitansh8/tinywatch";
 *   import { retry } from "@hitansh8/tinywatch/plugins/retry";
 *   init({ endpoint: "/api/tw" });
 *   use(retry({ maxRetries: 5 }));
 */
export function retry(opts: RetryOptions = {}): Plugin {
  const maxRetries = opts.maxRetries ?? 5;
  const baseDelay = opts.baseDelay ?? 1000;
  const maxDelay = opts.maxDelay ?? 30000;

  return {
    name: "retry",
    setup(ctx: PluginContext) {
      const timers = new Set<ReturnType<typeof setTimeout>>();
      // Track attempts PER EVENT (keyed off-band so nothing leaks onto the wire).
      // Keying per-event — not on the batch's first event — keeps the cap robust
      // even when re-enqueued events re-chunk with new traffic across flushes.
      const attempts = new WeakMap<TinywatchEvent, number>();

      ctx.onFlushError((events) => {
        // Bump each event's count; keep only those still under the cap. Events
        // that have failed maxRetries times are dropped (a dead endpoint can't
        // accumulate them forever, regardless of how batches re-chunk).
        const survivors: TinywatchEvent[] = [];
        let maxAttempt = 0;
        for (const e of events) {
          const n = (attempts.get(e) ?? 0) + 1;
          attempts.set(e, n);
          if (n <= maxRetries) {
            survivors.push(e);
            if (n > maxAttempt) maxAttempt = n;
          }
        }
        if (survivors.length === 0) return; // whole batch exhausted its retries

        const delay = Math.min(baseDelay * 2 ** (maxAttempt - 1), maxDelay);
        const t = setTimeout(() => {
          timers.delete(t);
          ctx.reenqueue(survivors);
        }, delay);
        timers.add(t);
      });

      // Teardown: cancel any pending re-deliveries.
      return () => {
        for (const t of timers) clearTimeout(t);
        timers.clear();
      };
    },
  };
}
