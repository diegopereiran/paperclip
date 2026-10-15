export interface CostDateRange {
  from?: Date;
  to?: Date;
  allTime?: boolean;
  /** Treat `to` as an exclusive bound (occurred_at < to) instead of inclusive. */
  toExclusive?: boolean;
}

/** Default reports match the UTC month used by monetary budgets. Explicit
 * bounds preserve the existing inclusive API; all-time must be requested. */
export function resolveCostDateRange(range?: CostDateRange, now = new Date()): CostDateRange {
  if (range?.allTime || range?.from || range?.to) return range;
  return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: now };
}
