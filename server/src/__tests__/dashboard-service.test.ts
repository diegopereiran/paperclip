import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { dashboardService, getUtcMonthStart } from "../services/dashboard.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres dashboard service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function utcDay(offsetDays: number): Date {
  const now = new Date();
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays, 12);
  return new Date(day);
}

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe("getUtcMonthStart", () => {
  it("anchors the monthly spend window to UTC month boundaries", () => {
    expect(getUtcMonthStart(new Date("2026-03-31T20:30:00.000-05:00")).toISOString()).toBe(
      "2026-04-01T00:00:00.000Z",
    );
    expect(getUtcMonthStart(new Date("2026-04-01T00:30:00.000+14:00")).toISOString()).toBe(
      "2026-03-01T00:00:00.000Z",
    );
  });
});

describeEmbeddedPostgres("dashboard service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dashboard-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("aggregates the full 14-day run activity window without recent-run truncation", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const today = utcDay(0);
    const weekAgo = utcDay(-7);

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "OtherAgent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values([
      ...Array.from({ length: 105 }, () => ({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: today,
      })),
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "failed",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "timed_out",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "cancelled",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        agentId: otherAgentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: weekAgo,
      },
    ]);

    const summary = await dashboardService(db).summary(companyId, { timeZone: "UTC" });

    expect(summary.runActivity).toHaveLength(14);
    const todayBucket = summary.runActivity.find((bucket) => bucket.date === utcDateKey(today));
    const weekAgoBucket = summary.runActivity.find((bucket) => bucket.date === utcDateKey(weekAgo));

    expect(todayBucket).toMatchObject({
      succeeded: 105,
      failed: 0,
      recovered: 0,
      other: 0,
      total: 105,
      failedByErrorCode: {},
    });
    expect(weekAgoBucket).toMatchObject({
      succeeded: 0,
      failed: 2,
      recovered: 0,
      other: 1,
      total: 3,
      // failed + timed_out with no error code both bucket under "unknown"
      failedByErrorCode: { unknown: 2 },
    });
  });

  it("separates recovered restart kills from true failures and breaks failures down by error code", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const day = utcDay(-2);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const base = {
      companyId,
      agentId,
      invocationSource: "assignment",
      createdAt: day,
    };

    // Direct recovery: a process-loss kill whose retry succeeded.
    const original = randomUUID();
    const retry = randomUUID();
    // Chained recovery: kill -> failed retry -> succeeded retry (both kills recovered).
    const chainedOriginal = randomUUID();
    const chainedRetry = randomUUID();
    const chainedRetrySuccess = randomUUID();
    // A genuine, unrecovered failure that should remain in the failed count.
    const trueFailure = randomUUID();

    await db.insert(heartbeatRuns).values([
      { ...base, id: original, status: "failed", errorCode: "process_lost" },
      { ...base, id: retry, status: "succeeded", retryOfRunId: original },
      { ...base, id: chainedOriginal, status: "failed", errorCode: "process_lost" },
      { ...base, id: chainedRetry, status: "failed", errorCode: "process_lost", retryOfRunId: chainedOriginal },
      { ...base, id: chainedRetrySuccess, status: "succeeded", retryOfRunId: chainedRetry },
      { ...base, id: trueFailure, status: "failed", errorCode: "provider_quota" },
    ]);

    const summary = await dashboardService(db).summary(companyId, { timeZone: "UTC" });
    const bucket = summary.runActivity.find((b) => b.date === utcDateKey(day));

    expect(bucket).toMatchObject({
      succeeded: 2,
      // original + chainedOriginal + chainedRetry all recovered via a later success
      recovered: 3,
      failed: 1,
      other: 0,
      total: 6,
      failedByErrorCode: { provider_quota: 1 },
    });
    // process_lost kills that recovered must not leak into the failed breakdown.
    expect(bucket?.failedByErrorCode.process_lost).toBeUndefined();
  });

  async function insertCompanyWithAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("buckets run activity by the calendar days of the given time zone", async () => {
    const { companyId, agentId } = await insertCompanyWithAgent();
    // 14:00 on 12 March in Auckland (NZDT, UTC+13).
    const now = new Date("2026-03-12T01:00:00.000Z");
    const base = { companyId, agentId, invocationSource: "assignment", status: "succeeded" };

    await db.insert(heartbeatRuns).values([
      // 12:30 on 11 March in Auckland, still 10 March in UTC.
      { ...base, id: randomUUID(), createdAt: new Date("2026-03-10T23:30:00.000Z") },
      // 00:30 on 27 February in Auckland: the first day of the window there,
      // but before the start of a UTC window.
      { ...base, id: randomUUID(), createdAt: new Date("2026-02-26T11:30:00.000Z") },
    ]);

    const summary = await dashboardService(db).summary(companyId, { now, timeZone: "Pacific/Auckland" });

    expect(summary.timeZone).toBe("Pacific/Auckland");
    expect(summary.runActivity).toHaveLength(14);
    expect(summary.runActivity[0]?.date).toBe("2026-02-27");
    expect(summary.runActivity[13]?.date).toBe("2026-03-12");
    const byDate = new Map(summary.runActivity.map((bucket) => [bucket.date, bucket]));
    expect(byDate.get("2026-03-11")).toMatchObject({ succeeded: 1, total: 1 });
    expect(byDate.get("2026-03-10")).toMatchObject({ succeeded: 0, total: 0 });
    expect(byDate.get("2026-02-27")).toMatchObject({ succeeded: 1, total: 1 });
  });

  it("counts a run cancelled by its own reassignment as handed off, not as other", async () => {
    const { companyId, agentId } = await insertCompanyWithAgent();
    const day = utcDay(-1);
    const finishedSelf = new Date(day.getTime() + 40_000);
    const finishedBoard = new Date(day.getTime() + 60_000);
    const selfRun = randomUUID();
    const boardRun = randomUUID();
    const base = {
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "cancelled",
      createdAt: day,
      startedAt: day,
    };

    await db.insert(heartbeatRuns).values([
      // The run reassigned its own issue (a stage hand-off), which cancels it.
      { ...base, id: selfRun, errorCode: "issue_reassigned", finishedAt: finishedSelf },
      // The board reassigned the issue while the agent was still working.
      { ...base, id: boardRun, errorCode: "issue_reassigned", finishedAt: finishedBoard },
      // A plain cancellation stays in "other".
      { ...base, id: randomUUID(), errorCode: "cancelled", finishedAt: finishedBoard },
    ]);
    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "agent",
        actorId: agentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: randomUUID(),
        agentId,
        runId: selfRun,
        createdAt: new Date(finishedSelf.getTime() + 300),
      },
      {
        companyId,
        actorType: "user",
        actorId: "board",
        action: "issue.updated",
        entityType: "issue",
        entityId: randomUUID(),
        createdAt: new Date(finishedBoard.getTime() + 300),
      },
    ]);

    const summary = await dashboardService(db).summary(companyId, { timeZone: "UTC" });
    const bucket = summary.runActivity.find((b) => b.date === utcDateKey(day));

    expect(bucket).toMatchObject({
      succeeded: 0,
      handedOff: 1,
      failed: 0,
      other: 2,
      total: 3,
    });
  });
});
