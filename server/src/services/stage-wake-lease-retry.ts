// Local patch for paperclipai/paperclip#13532. An execution-stage wake that is
// refused only because the previous run's environment lease is still
// unreleased is recorded as terminal `skipped` and never retried. Re-run
// admission a few times, spaced to cover slow remote lease release.
export const STAGE_WAKE_LEASE_RETRY_DELAYS_MS = [5_000, 20_000, 60_000, 120_000] as const;

type Entry = { attempt: number; timer: ReturnType<typeof setTimeout> | null };

export function createStageWakeLeaseRetry<Opts>(deps: {
  enqueue: (agentId: string, opts: Opts) => Promise<unknown>;
  onGiveUp?: (key: string, attempts: number) => void;
  onError?: (key: string, err: unknown) => void;
  delaysMs?: readonly number[];
}) {
  const delays = deps.delaysMs ?? STAGE_WAKE_LEASE_RETRY_DELAYS_MS;
  const entries = new Map<string, Entry>();
  // The re-entered enqueue may block again and call schedule() itself; the
  // entry keeps the attempt count across those calls and is dropped once a
  // retry no longer reschedules.
  function schedule(agentId: string, issueId: string, opts: Opts) {
    const key = `${agentId}:${issueId}`;
    const entry = entries.get(key) ?? { attempt: 0, timer: null };
    if (entry.timer) return;
    if (entry.attempt >= delays.length) {
      entries.delete(key);
      deps.onGiveUp?.(key, entry.attempt);
      return;
    }
    entries.set(key, entry);
    entry.timer = setTimeout(async () => {
      entry.timer = null;
      try {
        await deps.enqueue(agentId, opts);
      } catch (err) {
        deps.onError?.(key, err);
      }
      if (!entry.timer && entries.get(key) === entry) entries.delete(key);
    }, delays[entry.attempt]);
    entry.timer.unref?.();
    entry.attempt += 1;
  }
  return { schedule, pending: () => entries.size };
}
