const hits = new Map<string, { count: number; reset: number }>();

// How many expired entries to opportunistically evict per call. Bounded so the
// hot path stays O(1)-ish while keeping the Map from growing without limit.
const SWEEP_PER_CALL = 10;

/** Fixed-window limiter. Returns true if the request should be rejected. */
export function rateLimited(ip: string, perMinute: number): boolean {
  const now = Date.now();

  // Opportunistic eviction: Map preserves insertion order, so the oldest (most
  // likely expired) entries come first. Drop a few expired ones each call so
  // one-shot IPs don't accumulate forever (the entry is only otherwise rewritten
  // if that same IP returns after its window).
  let swept = 0;
  for (const [key, rec] of hits) {
    if (swept >= SWEEP_PER_CALL) break;
    if (now > rec.reset) {
      hits.delete(key);
      swept++;
    } else {
      break; // entries after a live one are newer; stop scanning
    }
  }

  const rec = hits.get(ip);
  if (!rec || now > rec.reset) {
    hits.set(ip, { count: 1, reset: now + 60_000 });
    return false;
  }
  rec.count += 1;
  return rec.count > perMinute;
}

/** Test-only: clear all limiter state so tests aren't order-dependent. */
export function __resetRateLimiter(): void {
  hits.clear();
}

// ⚠️ In-memory and per-instance: resets on cold starts and isn't shared across
// serverless instances. Fine for single-node and dev. For production at the
// edge, back this with a Durable Object / KV / Redis and inject your own limiter.
