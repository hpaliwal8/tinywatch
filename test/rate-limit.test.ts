import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __rateLimiterSize, __resetRateLimiter, rateLimited } from "../src/server/rate-limit";

beforeEach(() => {
  __resetRateLimiter();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("rate limiter", () => {
  it("allows up to perMinute then rejects within a window", () => {
    for (let i = 0; i < 3; i++) expect(rateLimited("1.1.1.1", 3)).toBe(false);
    expect(rateLimited("1.1.1.1", 3)).toBe(true); // 4th in the same window
  });

  it("resets after the window elapses", () => {
    for (let i = 0; i < 3; i++) rateLimited("1.1.1.1", 3);
    expect(rateLimited("1.1.1.1", 3)).toBe(true);
    vi.advanceTimersByTime(61_000); // window lapsed
    expect(rateLimited("1.1.1.1", 3)).toBe(false);
  });

  it("reclaims expired one-shot entries as later calls sweep them", () => {
    for (let i = 0; i < 50; i++) rateLimited(`oneshot-${i}`, 1000);
    expect(__rateLimiterSize()).toBe(50);

    vi.advanceTimersByTime(61_000); // all one-shots now expired

    // The bounded sweep reclaims up to SWEEP_PER_CALL per call; drive enough
    // calls (via a live "driver" ip) to fully drain the expired set.
    for (let i = 0; i < 60; i++) rateLimited("driver", 1_000_000);
    expect(__rateLimiterSize()).toBe(1); // only the live driver remains
  });

  it("keeps distinct buckets per ip", () => {
    expect(rateLimited("a", 1)).toBe(false);
    expect(rateLimited("a", 1)).toBe(true);
    expect(rateLimited("b", 1)).toBe(false); // independent of "a"
  });
});
