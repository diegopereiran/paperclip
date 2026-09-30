import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStageWakeLeaseRetry } from "../services/stage-wake-lease-retry.js";

// Models #13532: admission refuses the stage wake while the previous run's
// lease is unreleased, and the lease is released N ms after the cancel.
function harness(releaseAfterMs: number, delaysMs?: readonly number[]) {
  const start = Date.now();
  const runs: string[] = [];
  const retry = createStageWakeLeaseRetry<{ id: string }>({
    delaysMs,
    enqueue: async (agentId, opts) => {
      if (Date.now() - start < releaseAfterMs) {
        retry.schedule(agentId, "issue-1", opts); // admission blocked again
        return { kind: "deferred" };
      }
      runs.push(opts.id);
      return { kind: "run" };
    },
    onGiveUp: () => runs.push("gave-up"),
  });
  return { retry, runs };
}

describe("stage wake lease retry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("dispatches after a 53 s lease release (Senior Engineer worst case)", async () => {
    const { retry, runs } = harness(53_000);
    retry.schedule("approver", "issue-1", { id: "stage-wake" }); // first block at t=0
    await vi.advanceTimersByTimeAsync(4_999);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(runs).toEqual(["stage-wake"]);
    expect(retry.pending()).toBe(0);
  });

  it("dispatches at the first retry when the lease is already released", async () => {
    const { retry, runs } = harness(1_000);
    retry.schedule("approver", "issue-1", { id: "stage-wake" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs).toEqual(["stage-wake"]);
  });

  it("does not stack timers for repeated blocks of the same agent and issue", async () => {
    const { retry, runs } = harness(1_000);
    retry.schedule("approver", "issue-1", { id: "a" });
    retry.schedule("approver", "issue-1", { id: "b" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs).toEqual(["a"]);
  });

  it("gives up after the last delay and forgets the entry", async () => {
    const { retry, runs } = harness(Number.MAX_SAFE_INTEGER);
    retry.schedule("approver", "issue-1", { id: "stage-wake" });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(runs).toEqual(["gave-up"]);
    expect(retry.pending()).toBe(0);
  });
});
