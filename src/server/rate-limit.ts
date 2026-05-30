const hits = new Map<string, { count: number; reset: number }>();

// How many expired entries to opportunistically evict per call. Bounded so the
// hot path stays O(1)-ish while keeping the Map from growing without limit.
const SWEEP_PER_CALL = 10;

/** Fixed-window limiter. Returns true if the request should be rejected. */
export function rateLimited(ip: string, perMinute: number): boolean {
  const now = Date.now();

  // Opportunistic eviction: scan a bounded window of entries each call and drop
  // expired ones. We scan unconditionally (no early break) — a long-lived entry
  // pinned near the front must not stop us reaching expired entries behind it,
  // which an order-dependent break would (Map.set on an existing key keeps its
  // position, so reset order != insertion order).
  let scanned = 0;
  for (const [key, rec] of hits) {
    if (scanned >= SWEEP_PER_CALL) break;
    scanned++;
    if (now > rec.reset) hits.delete(key);
  }

  const rec = hits.get(ip);
  if (!rec || now > rec.reset) {
    // delete-before-set so a re-armed entry moves to the tail, keeping younger
    // resets toward the end (helps the bounded scan find expired entries first).
    hits.delete(ip);
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

/** Test-only: current number of tracked entries (to assert eviction). */
export function __rateLimiterSize(): number {
  return hits.size;
}

// ⚠️ In-memory and per-instance: resets on cold starts and isn't shared across
// serverless instances. Fine for single-node and dev. For production at the
// edge, back this with a Durable Object / KV / Redis and inject your own limiter.
