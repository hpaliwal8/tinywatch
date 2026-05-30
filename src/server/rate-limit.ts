const hits = new Map<string, { count: number; reset: number }>();

/** Fixed-window limiter. Returns true if the request should be rejected. */
export function rateLimited(ip: string, perMinute: number): boolean {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.reset) {
    hits.set(ip, { count: 1, reset: now + 60_000 });
    return false;
  }
  rec.count += 1;
  return rec.count > perMinute;
}

// ⚠️ In-memory and per-instance: resets on cold starts and isn't shared across
// serverless instances. Fine for single-node and dev. For production at the
// edge, back this with a Durable Object / KV / Redis and inject your own limiter.
