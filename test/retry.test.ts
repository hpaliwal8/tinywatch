import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retry } from "../src/plugins/retry";
import type { PluginContext, TinywatchEvent } from "../src/types";

// Drive the plugin via a mock PluginContext: capture the onFlushError handler,
// record reenqueue calls, and use fake timers to step backoff deterministically.

function harness(opts?: Parameters<typeof retry>[0]) {
  let onError: ((events: TinywatchEvent[], err: unknown) => void) | undefined;
  const reenqueued: TinywatchEvent[][] = [];
  const ctx: PluginContext = {
    track: vi.fn(),
    config: {} as PluginContext["config"],
    onFlushError(fn) {
      onError = fn;
    },
    reenqueue(events) {
      reenqueued.push(events);
    },
  };
  const teardown = retry(opts).setup(ctx);
  return {
    fail: (events: TinywatchEvent[]) => onError!(events, new Error("network")),
    reenqueued,
    teardown,
  };
}

const ev = (id: string): TinywatchEvent => ({
  name: "$pageview",
  anonymousId: "a",
  sessionId: "s",
  path: "/",
  ts: 0,
  id,
} as TinywatchEvent & { id: string });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("retry plugin", () => {
  it("re-enqueues a failed batch after a backoff delay", () => {
    const h = harness({ baseDelay: 1000 });
    const batch = [ev("e1"), ev("e2")];
    h.fail(batch);

    expect(h.reenqueued).toHaveLength(0); // not yet — waiting on backoff
    vi.advanceTimersByTime(1000);
    expect(h.reenqueued).toHaveLength(1);
    // Same event objects re-delivered (ids preserved), though as a filtered
    // survivors array rather than the original batch reference.
    expect(h.reenqueued[0]).toEqual(batch);
    expect(h.reenqueued[0]![0]).toBe(batch[0]);
  });

  it("uses exponential backoff across attempts", () => {
    const h = harness({ baseDelay: 1000, maxDelay: 60000 });
    const batch = [ev("e1")];

    h.fail(batch); // attempt 1 -> 1000ms
    vi.advanceTimersByTime(1000);
    expect(h.reenqueued).toHaveLength(1);

    h.fail(batch); // attempt 2 -> 2000ms
    vi.advanceTimersByTime(1999);
    expect(h.reenqueued).toHaveLength(1); // not yet
    vi.advanceTimersByTime(1);
    expect(h.reenqueued).toHaveLength(2);

    h.fail(batch); // attempt 3 -> 4000ms
    vi.advanceTimersByTime(4000);
    expect(h.reenqueued).toHaveLength(3);
  });

  it("caps delay at maxDelay", () => {
    const h = harness({ baseDelay: 1000, maxDelay: 1500 });
    const batch = [ev("e1")];
    h.fail(batch); // 1000
    vi.advanceTimersByTime(1000);
    h.fail(batch); // would be 2000, capped to 1500
    vi.advanceTimersByTime(1499);
    expect(h.reenqueued).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(h.reenqueued).toHaveLength(2);
  });

  it("drops the batch after maxRetries (no infinite retry storm)", () => {
    const h = harness({ baseDelay: 1, maxRetries: 3 });
    const batch = [ev("e1")];
    for (let i = 0; i < 5; i++) {
      h.fail(batch);
      vi.advanceTimersByTime(10000);
    }
    // attempts 1,2,3 re-enqueue; 4th and 5th are dropped.
    expect(h.reenqueued).toHaveLength(3);
  });

  it("caps PER EVENT even when batches re-chunk with new traffic", () => {
    // Regression for the events[0]-keyed cap bug: a persistently-failing event
    // must not get unbounded retries just because a fresh event keeps landing
    // at index 0 of the re-chunked batch.
    const h = harness({ baseDelay: 1, maxRetries: 3 });
    const stuck = ev("stuck");
    let n = 0;
    for (let i = 0; i < 6; i++) {
      // Each failure presents a DIFFERENT new event at index 0, then `stuck`.
      h.fail([ev(`new${n++}`), stuck]);
      vi.advanceTimersByTime(10000);
    }
    // `stuck` is re-enqueued on attempts 1,2,3 then dropped — never more than
    // maxRetries times, despite index 0 always being a brand-new event.
    const stuckReenqueues = h.reenqueued.filter((b) => b.includes(stuck)).length;
    expect(stuckReenqueues).toBe(3);
  });

  it("drops only the exhausted events, keeps re-delivering the rest", () => {
    const h = harness({ baseDelay: 1, maxRetries: 2 });
    const old = ev("old");
    // old fails twice (hits cap), then a fresh event joins it.
    h.fail([old]); vi.advanceTimersByTime(10);
    h.fail([old]); vi.advanceTimersByTime(10);
    const fresh = ev("fresh");
    h.fail([old, fresh]); vi.advanceTimersByTime(10);
    // old is exhausted (3rd failure > maxRetries 2) and dropped; fresh survives.
    const last = h.reenqueued[h.reenqueued.length - 1]!;
    expect(last).toEqual([fresh]);
    expect(last).not.toContain(old);
  });

  it("teardown cancels pending re-deliveries", () => {
    const h = harness({ baseDelay: 5000 });
    h.fail([ev("e1")]);
    h.teardown?.(); // cancel before the timer fires
    vi.advanceTimersByTime(10000);
    expect(h.reenqueued).toHaveLength(0);
  });

  it("ignores an empty failed batch", () => {
    const h = harness();
    h.fail([]);
    vi.advanceTimersByTime(10000);
    expect(h.reenqueued).toHaveLength(0);
  });
});
