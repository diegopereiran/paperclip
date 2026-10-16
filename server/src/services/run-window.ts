import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { badRequest } from "../errors.js";
import { costService } from "./costs.js";

export const RUN_WINDOW_DEFAULT_TZ = "Pacific/Auckland";
export const RUN_WINDOW_DEFAULT_LIMIT = 500;
export const RUN_WINDOW_MAX_LIMIT = 2000;
const MAX_ROOT_DEPTH = 32;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RunWindowQuery = {
  month?: string;
  from?: string;
  to?: string;
  tz?: string;
  cursor?: string;
  limit?: string;
};

export type RunWindowRow = {
  runId: string;
  agentId: string;
  status: string;
  issueId: string | null;
  rootIssueId: string | null;
  retryOfRunId: string | null;
  continuationAttempt: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type RunWindowPercentiles = { p50: number | null; p95: number | null };

export type RunWindowClassCounts = { runCount: number; costCents: number; acceptedOutcomeCount: number };

export type RunWindowClassRow = RunWindowClassCounts & {
  /** `P1`..`P5`; the most severe when an issue has several; null when none. */
  priority: string | null;
  enhancement: boolean;
  /** `XXS`..`XXL`; the largest when an issue has several; null when none. */
  size: string | null;
};

export type RunWindowOutcomes = {
  /** Issues whose accepted_outcome_at falls in the window. */
  acceptedOutcomeCount: number;
  /** Every cost event whose occurred_at falls in the window, in cents as stored. */
  costCents: number;
  /** costCents / acceptedOutcomeCount; null when the count is 0. */
  costCentsPerAcceptedOutcome: number | null;
  /** Exclusive attribution (costs.ts byProject); projectId null is Unattributed. Sums to costCents. */
  costByProject: Array<{ projectId: string | null; costCents: number }>;
  classes: {
    definition: string;
    /** One row per (priority, enhancement, size) combination that has any run, cost or accepted outcome. */
    rows: RunWindowClassRow[];
    /** Runs, cost and accepted outcomes with no issue or no P, enhancement or size label. */
    unclassified: RunWindowClassCounts;
  };
};

export type RunWindowResponse = {
  window: {
    tz: string;
    from: string;
    to: string;
    /** Timestamp that places a run in the window. */
    windowField: "created_at";
    /** A child run is a run whose issue (context_snapshot issueId) has a parent_id. */
    childRunDefinition: string;
    /** A timed-out run has status = 'timed_out'. */
    timeoutDefinition: string;
  };
  aggregates: {
    runCount: number;
    byStatus: Record<string, number>;
    timeoutCount: number;
    retryCount: number;
    continuationCount: number;
    childRunCount: number;
    durationSeconds: RunWindowPercentiles;
    wakeToFinishSeconds: RunWindowPercentiles;
  };
  outcomes: RunWindowOutcomes;
  rows: RunWindowRow[];
  nextCursor: string | null;
};

type ResolvedWindow = { tz: string; fromDate: string; toDate: string };

// Postgres rejects year 0000 and years past 9999.
const MIN_YEAR = 1;
const MAX_MONTH_YEAR = 9998;

const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:\d{2})?)$/;

function isValidDate(value: string) {
  if (!DATE_RE.test(value)) return false;
  if (Number(value.slice(0, 4)) < MIN_YEAR) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

// IANA region names only. Intl also accepts offsets such as "+05:00", which Postgres reads as POSIX
// (a positive offset is west of UTC), so an offset would silently shift the window.
const IANA_TIME_ZONES = new Set<string>([...Intl.supportedValuesOf("timeZone"), "UTC", "Etc/UTC"]);

function isValidTz(tz: string) {
  return IANA_TIME_ZONES.has(tz);
}

export function resolveRunWindowQuery(query: RunWindowQuery): ResolvedWindow {
  const tz = query.tz?.trim() || RUN_WINDOW_DEFAULT_TZ;
  if (!isValidTz(tz)) throw badRequest("tz must be an IANA time zone name");
  if (query.month) {
    if (query.from || query.to) throw badRequest("Use either month or from/to, not both");
    const m = MONTH_RE.exec(query.month);
    const year = m ? Number(m[1]) : 0;
    const month = m ? Number(m[2]) : 0;
    if (!m || month < 1 || month > 12 || year < MIN_YEAR || year > MAX_MONTH_YEAR) throw badRequest("month must be YYYY-MM");
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    const pad = (n: number) => String(n).padStart(2, "0");
    return { tz, fromDate: `${m[1]}-${m[2]}-01`, toDate: `${nextYear}-${pad(nextMonth)}-01` };
  }
  if (!query.from || !query.to) throw badRequest("Provide month=YYYY-MM or both from and to (YYYY-MM-DD)");
  if (!isValidDate(query.from) || !isValidDate(query.to)) throw badRequest("from and to must be YYYY-MM-DD dates");
  if (query.to <= query.from) throw badRequest("to must be after from (to is exclusive)");
  return { tz, fromDate: query.from, toDate: query.to };
}

export function parseRunWindowLimit(raw: string | undefined) {
  if (raw === undefined) return RUN_WINDOW_DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) throw badRequest("limit must be a positive integer");
  const n = Number(raw);
  if (n < 1) throw badRequest("limit must be a positive integer");
  return Math.min(n, RUN_WINDOW_MAX_LIMIT);
}

type Cursor = { c: string; i: string };

function encodeCursor(cursor: Cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>;
    if (
      typeof parsed.c === "string" &&
      typeof parsed.i === "string" &&
      UUID_RE.test(parsed.i) &&
      CURSOR_TS_RE.test(parsed.c) &&
      !Number.isNaN(Date.parse(parsed.c))
    ) {
      return { c: parsed.c, i: parsed.i };
    }
  } catch {
    // fall through
  }
  throw badRequest("cursor is not valid");
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const iso = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string).toISOString());

const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL"];
const PRIORITY_LABEL_RE = /^p([1-5])$/i;
const SIZE_LABEL_RE = /^size\s*[:/-]?\s*(xxs|xs|s|m|l|xl|xxl)$/i;
const ENHANCEMENT_LABEL_RE = /^enhancement$/i;

type TicketClass = { priority: number | null; enhancement: boolean; size: number | null };

/** Labels are matched by name, so the table works for every company without label ids. */
function classifyLabels(names: string[]): TicketClass | null {
  let priority: number | null = null;
  let size: number | null = null;
  let enhancement = false;
  for (const raw of names) {
    const name = raw.trim();
    const p = PRIORITY_LABEL_RE.exec(name);
    if (p) priority = priority === null ? Number(p[1]) : Math.min(priority, Number(p[1]));
    const z = SIZE_LABEL_RE.exec(name);
    if (z) size = Math.max(size ?? -1, SIZE_ORDER.indexOf(z[1]!.toUpperCase()));
    if (ENHANCEMENT_LABEL_RE.test(name)) enhancement = true;
  }
  return priority === null && size === null && !enhancement ? null : { priority, enhancement, size };
}

async function getOutcomes(
  db: Db,
  companyId: string,
  fromTs: string,
  toTs: string,
  inWindow: ReturnType<typeof sql>,
  runIssueId: ReturnType<typeof sql>,
): Promise<RunWindowOutcomes> {
  const costRange = { from: new Date(fromTs), to: new Date(toTs), toExclusive: true };
  const projectRows = await costService(db).byProject(companyId, costRange);
  const costByProject = projectRows.map((r) => ({ projectId: r.projectId ?? null, costCents: Number(r.costCents) }));
  const costCents = costByProject.reduce((a, r) => a + r.costCents, 0);

  const runRes = await db.execute(sql`
    SELECT ${runIssueId} AS issue_id, count(*)::int AS n FROM heartbeat_runs r WHERE ${inWindow} GROUP BY 1
  `);
  // Class cost: the event's own issue, else the issue of its run. Each event resolves to at most one issue.
  const costRes = await db.execute(sql`
    SELECT coalesce(ce.issue_id, ${runIssueId}) AS issue_id, sum(ce.cost_cents)::double precision AS cents
    FROM cost_events ce
    LEFT JOIN heartbeat_runs r ON r.id = ce.heartbeat_run_id AND r.company_id = ce.company_id
    WHERE ce.company_id = ${companyId}::uuid AND ce.occurred_at >= ${fromTs}::timestamptz AND ce.occurred_at < ${toTs}::timestamptz
    GROUP BY 1
  `);
  const acceptedRes = await db.execute(sql`
    SELECT i.id AS issue_id FROM issues i
    WHERE i.company_id = ${companyId}::uuid AND i.accepted_outcome_at >= ${fromTs}::timestamptz AND i.accepted_outcome_at < ${toTs}::timestamptz
  `);
  const labelRes = await db.execute(sql`
    SELECT il.issue_id AS issue_id, l.name AS name
    FROM issue_labels il JOIN labels l ON l.id = il.label_id
    WHERE il.company_id = ${companyId}::uuid AND l.company_id = ${companyId}::uuid
      AND btrim(l.name) ~* '^(p[1-5]|enhancement|size[[:space:]]*[:/-]?[[:space:]]*(xxs|xs|s|m|l|xl|xxl))$'
  `);

  const namesByIssue = new Map<string, string[]>();
  for (const row of labelRes as unknown as Array<{ issue_id: string; name: string }>) {
    const list = namesByIssue.get(row.issue_id) ?? [];
    list.push(row.name);
    namesByIssue.set(row.issue_id, list);
  }

  const unclassified: RunWindowClassCounts = { runCount: 0, costCents: 0, acceptedOutcomeCount: 0 };
  const classes = new Map<string, { cls: TicketClass; counts: RunWindowClassCounts }>();
  const add = (issueId: string | null, field: keyof RunWindowClassCounts, amount: number) => {
    const cls = issueId ? classifyLabels(namesByIssue.get(issueId) ?? []) : null;
    if (!cls) {
      unclassified[field] += amount;
      return;
    }
    const key = `${cls.priority}|${cls.enhancement}|${cls.size}`;
    let entry = classes.get(key);
    if (!entry) {
      entry = { cls, counts: { runCount: 0, costCents: 0, acceptedOutcomeCount: 0 } };
      classes.set(key, entry);
    }
    entry.counts[field] += amount;
  };
  for (const row of runRes as unknown as Array<{ issue_id: string | null; n: number }>) add(row.issue_id, "runCount", Number(row.n));
  for (const row of costRes as unknown as Array<{ issue_id: string | null; cents: number }>) add(row.issue_id, "costCents", Number(row.cents));
  const accepted = acceptedRes as unknown as Array<{ issue_id: string }>;
  for (const row of accepted) add(row.issue_id, "acceptedOutcomeCount", 1);

  const rows: RunWindowClassRow[] = [...classes.values()]
    .sort((a, b) =>
      (a.cls.priority ?? 9) - (b.cls.priority ?? 9) ||
      Number(b.cls.enhancement) - Number(a.cls.enhancement) ||
      (a.cls.size ?? 99) - (b.cls.size ?? 99))
    .map(({ cls, counts }) => ({
      priority: cls.priority === null ? null : `P${cls.priority}`,
      enhancement: cls.enhancement,
      size: cls.size === null ? null : SIZE_ORDER[cls.size]!,
      ...counts,
    }));

  return {
    acceptedOutcomeCount: accepted.length,
    costCents,
    costCentsPerAcceptedOutcome: accepted.length > 0 ? costCents / accepted.length : null,
    costByProject,
    classes: {
      definition:
        "one row per (P label, enhancement label, size label) found by label name; several P labels count as the most severe, several size labels as the largest; cost is attributed through the event's issue, else its run's issue",
      rows,
      unclassified,
    },
  };
}

/** Read-only, calendar-window export of run telemetry. No prompts, logs, results or context. */
export async function getRunWindow(db: Db, companyId: string, query: RunWindowQuery): Promise<RunWindowResponse> {
  const { tz, fromDate, toDate } = resolveRunWindowQuery(query);
  const limit = parseRunWindowLimit(query.limit);
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;

  const boundsRes = await db.execute(sql`
    SELECT (${fromDate}::timestamp AT TIME ZONE ${tz}) AS from_ts, (${toDate}::timestamp AT TIME ZONE ${tz}) AS to_ts
  `);
  const bounds = (boundsRes as unknown as Array<{ from_ts: unknown; to_ts: unknown }>)[0]!;
  const fromTs = iso(bounds.from_ts)!;
  const toTs = iso(bounds.to_ts)!;

  // Issue link: the run's context_snapshot issueId, as the run list uses it.
  const runIssueId = sql`(CASE WHEN r.context_snapshot ->> 'issueId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (r.context_snapshot ->> 'issueId')::uuid END)`;
  const inWindow = sql`r.company_id = ${companyId}::uuid AND r.created_at >= ${fromTs}::timestamptz AND r.created_at < ${toTs}::timestamptz`;

  const statusRes = await db.execute(sql`
    SELECT r.status AS status, count(*)::int AS n FROM heartbeat_runs r WHERE ${inWindow} GROUP BY r.status
  `);
  const byStatus: Record<string, number> = {};
  for (const row of statusRes as unknown as Array<{ status: string; n: number }>) byStatus[row.status] = Number(row.n);

  const aggRes = await db.execute(sql`
    SELECT
      count(*)::int AS run_count,
      (count(*) FILTER (WHERE r.status = 'timed_out'))::int AS timeout_count,
      (count(*) FILTER (WHERE r.retry_of_run_id IS NOT NULL))::int AS retry_count,
      (count(*) FILTER (WHERE r.continuation_attempt > 0))::int AS continuation_count,
      (count(*) FILTER (WHERE i.parent_id IS NOT NULL))::int AS child_count,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (r.finished_at - r.started_at)))
        FILTER (WHERE r.finished_at IS NOT NULL AND r.started_at IS NOT NULL) AS dur_p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (r.finished_at - r.started_at)))
        FILTER (WHERE r.finished_at IS NOT NULL AND r.started_at IS NOT NULL) AS dur_p95,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (r.finished_at - coalesce(w.requested_at, r.created_at))))
        FILTER (WHERE r.finished_at IS NOT NULL) AS w2f_p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (r.finished_at - coalesce(w.requested_at, r.created_at))))
        FILTER (WHERE r.finished_at IS NOT NULL) AS w2f_p95
    FROM heartbeat_runs r
    LEFT JOIN agent_wakeup_requests w ON w.id = r.wakeup_request_id AND w.company_id = r.company_id
    LEFT JOIN issues i ON i.id = ${runIssueId} AND i.company_id = r.company_id
    WHERE ${inWindow}
  `);
  const agg = (aggRes as unknown as Array<Record<string, unknown>>)[0]!;

  const cursorFilter = cursor
    ? sql`AND (r.created_at, r.id) > (${cursor.c}::timestamptz, ${cursor.i}::uuid)`
    : sql``;
  const pageRes = await db.execute(sql`
    SELECT r.id AS id, r.agent_id AS agent_id, r.status AS status, ${runIssueId} AS issue_id,
      r.retry_of_run_id AS retry_of_run_id, r.continuation_attempt AS continuation_attempt,
      r.created_at AS created_at, r.created_at::text AS created_at_text, r.started_at AS started_at, r.finished_at AS finished_at
    FROM heartbeat_runs r
    WHERE ${inWindow} ${cursorFilter}
    ORDER BY r.created_at ASC, r.id ASC
    LIMIT ${limit + 1}
  `);
  const pageRows = pageRes as unknown as Array<Record<string, unknown>>;
  const hasMore = pageRows.length > limit;
  const page = hasMore ? pageRows.slice(0, limit) : pageRows;

  const issueIds = [...new Set(page.map((r) => r.issue_id).filter((v): v is string => typeof v === "string"))];
  const rootByIssue = new Map<string, string>();
  if (issueIds.length > 0) {
    const idList = sql.join(issueIds.map((id) => sql`${id}::uuid`), sql`, `);
    const rootRes = await db.execute(sql`
      WITH RECURSIVE chain(start_id, id, parent_id, depth, path) AS (
        SELECT i.id, i.id, i.parent_id, 0, ARRAY[i.id]
        FROM issues i WHERE i.company_id = ${companyId}::uuid AND i.id IN (${idList})
        UNION ALL
        SELECT c.start_id, p.id, p.parent_id, c.depth + 1, c.path || p.id
        FROM chain c JOIN issues p ON p.id = c.parent_id
        WHERE p.company_id = ${companyId}::uuid AND NOT (p.id = ANY(c.path)) AND c.depth < ${MAX_ROOT_DEPTH}
      )
      SELECT DISTINCT ON (start_id) start_id, id AS root_id FROM chain ORDER BY start_id, depth DESC
    `);
    for (const row of rootRes as unknown as Array<{ start_id: string; root_id: string }>) {
      rootByIssue.set(row.start_id, row.root_id);
    }
  }

  const rows: RunWindowRow[] = page.map((r) => {
    const issueId = (r.issue_id as string | null) ?? null;
    return {
      runId: r.id as string,
      agentId: r.agent_id as string,
      status: r.status as string,
      issueId,
      rootIssueId: issueId ? rootByIssue.get(issueId) ?? issueId : null,
      retryOfRunId: (r.retry_of_run_id as string | null) ?? null,
      continuationAttempt: Number(r.continuation_attempt),
      createdAt: iso(r.created_at)!,
      startedAt: iso(r.started_at),
      finishedAt: iso(r.finished_at),
    };
  });
  const outcomes = await getOutcomes(db, companyId, fromTs, toTs, inWindow, runIssueId);
  const last = page[page.length - 1];
  return {
    window: {
      tz,
      from: fromTs,
      to: toTs,
      windowField: "created_at",
      childRunDefinition: "run whose issue (context_snapshot.issueId) has a non-null parent_id",
      timeoutDefinition: "status = 'timed_out'",
    },
    aggregates: {
      runCount: Number(agg.run_count),
      byStatus,
      timeoutCount: Number(agg.timeout_count),
      retryCount: Number(agg.retry_count),
      continuationCount: Number(agg.continuation_count),
      childRunCount: Number(agg.child_count),
      durationSeconds: { p50: num(agg.dur_p50), p95: num(agg.dur_p95) },
      wakeToFinishSeconds: { p50: num(agg.w2f_p50), p95: num(agg.w2f_p95) },
    },
    outcomes,
    rows,
    nextCursor: hasMore && last ? encodeCursor({ c: last.created_at_text as string, i: last.id as string }) : null,
  };
}
