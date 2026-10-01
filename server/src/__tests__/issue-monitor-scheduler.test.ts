import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@paperclipai/shared";
import {
  activityLog,
  chatActions,
  chatEndpoints,
  toolApplications,
  toolConnections,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySecrets,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueDocuments,
  instanceSettings,
  issues,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "../services/issue-execution-policy.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { secretService } from "../services/secrets.ts";
import { createGitHubMonitorWebhookSink } from "../services/github-monitor-webhook-sink.ts";
import { listWatchedMonitorPullRequests, sanitizeIssueMonitorTrigger } from "../services/issue-monitor-pull-requests.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue monitor scheduler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue monitor scheduler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const seededAgentIds = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-monitor-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  async function waitForHeartbeatIdle(timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
      if (active.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue monitor heartbeat runs to settle");
  }

  async function heartbeatSideEffectFingerprint() {
    const [active, events, activity, leases, runtimeServices] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`),
      db.select({ count: sql<number>`count(*)` }).from(heartbeatRunEvents),
      db.select({ count: sql<number>`count(*)` }).from(activityLog),
      db.select({ count: sql<number>`count(*)` }).from(environmentLeases),
      db.select({ count: sql<number>`count(*)` }).from(workspaceRuntimeServices),
    ]);

    return [
      active[0]?.count ?? 0,
      events[0]?.count ?? 0,
      activity[0]?.count ?? 0,
      leases[0]?.count ?? 0,
      runtimeServices[0]?.count ?? 0,
    ].join(":");
  }

  async function waitForHeartbeatSideEffectsSettled(timeoutMs = 5_000, quietMs = 500) {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      const current = await heartbeatSideEffectFingerprint();
      const activeCount = Number(current.split(":")[0] ?? 0);
      if (current !== previous || activeCount > 0) {
        previous = current;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= quietMs) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue monitor heartbeat side effects to settle");
  }

  async function cleanupRows() {
    await waitForHeartbeatSideEffectsSettled();
    await db.delete(heartbeatRunEvents);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(chatActions);
    await db.delete(chatEndpoints);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  afterEach(async () => {
    // The no-op process fixtures deliberately leave no task disposition. The
    // real lifecycle can now leave a bounded, scheduled repair after the
    // monitor assertions. Cancel that remaining work only during teardown.
    const heartbeat = heartbeatService(db);
    await heartbeat.drainActiveRunExecutions();
    const pending = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
    for (const run of pending) await heartbeat.cancelRun(run.id, "Monitor fixture teardown", { suppressImmediateRecovery: true });
    await heartbeat.drainActiveRunExecutions();
    seededAgentIds.clear();
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await cleanupRows();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(input?: {
    agentStatus?: "active" | "paused";
    issueStatus?: "in_progress" | "in_review";
    monitorAttemptCount?: number;
    monitor?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const nextCheckAt = new Date("2026-04-11T12:30:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    const monitorAttemptCount = input?.monitorAttemptCount ?? 0;
    const monitor = {
      nextCheckAt: nextCheckAt.toISOString(),
      notes: "Check deploy",
      scheduledBy: "assignee",
      ...(input?.monitor ?? {}),
    };

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Monitor Bot",
      role: "engineer",
      status: input?.agentStatus ?? "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    seededAgentIds.add(agentId);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Watch external deploy",
      status: input?.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        monitor,
      },
      executionState: {
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          status: "scheduled",
          nextCheckAt: nextCheckAt.toISOString(),
          lastTriggeredAt: null,
          attemptCount: monitorAttemptCount,
          notes: "Check deploy",
          scheduledBy: "assignee",
          serviceName: typeof monitor.serviceName === "string" ? monitor.serviceName : null,
          externalRef: typeof monitor.externalRef === "string" ? monitor.externalRef : null,
          timeoutAt: typeof monitor.timeoutAt === "string" ? monitor.timeoutAt : null,
          maxAttempts: typeof monitor.maxAttempts === "number" ? monitor.maxAttempts : null,
          recoveryPolicy: typeof monitor.recoveryPolicy === "string" ? monitor.recoveryPolicy : null,
          clearedAt: null,
          clearReason: null,
        },
      },
      monitorNextCheckAt: nextCheckAt,
      monitorAttemptCount,
      monitorNotes: "Check deploy",
      monitorScheduledBy: "assignee",
    });

    return { companyId, agentId, issueId, nextCheckAt };
  }

  async function seedEndpoint(companyId: string, agentId: string) {
    const endpointId = randomUUID();
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    await db.insert(toolApplications).values({
      id: applicationId,
      companyId,
      applicationKey: `chat:github:${endpointId}`,
      name: "GitHub chat",
      type: "chat",
      status: "active",
    });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId,
      name: "GitHub chat",
      uid: `chat-github-${endpointId}`,
      connectionPurpose: "channel",
      transport: "chat_sdk",
      authKind: "api_key",
      config: { provider: "github" },
      transportConfig: {},
    });
    await db.insert(chatEndpoints).values({
      id: endpointId,
      companyId,
      connectionId,
      provider: "github",
      publicId: `pub-${endpointId}`,
      assignedAgentId: agentId,
      status: "active",
    });
    return endpointId;
  }

  function makeSink() {
    const heartbeat = heartbeatService(db);
    return createGitHubMonitorWebhookSink(db, {
      triggerMonitor: (issueId, input) => heartbeat.triggerIssueMonitor(issueId, input),
    });
  }

  it("triggers due issue monitors once and clears the one-shot schedule", async () => {
    const { issueId, agentId } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorAttemptCount).toBe(1);
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(tickAt.toISOString());
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "triggered",
      lastTriggeredAt: tickAt.toISOString(),
      attemptCount: 1,
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_triggered");
  });

  it.each(["unknown", "exhausted"] as const)("does not replay a quota monitor with %s execution evidence", async (kind) => {
    const sourceRunId = randomUUID();
    const { companyId, issueId, agentId } = await seedFixture({
      monitor: { serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: sourceRunId },
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId, status: "failed", errorCode: "provider_quota",
      finishedAt: new Date("2026-04-11T12:00:00.000Z"), contextSnapshot: { issueId },
      scheduledRetryAttempt: kind === "exhausted" ? 2 : 0,
      resultJson: kind === "exhausted" ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } : null,
    });
    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"));
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    expect(await db.select().from(issueRecoveryActions)).toMatchObject([{ ownerType: "board", evidence: { runId: sourceRunId } }]);
  });

  it("wakes a cross-agent review participant for provider quota monitors", async () => {
    const sourceRunId = randomUUID();
    const { companyId, issueId, agentId: assigneeAgentId } = await seedFixture({
      issueStatus: "in_review",
      monitor: { serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: sourceRunId },
    });
    const participantAgentId = randomUUID();
    await db.insert(agents).values({
      id: participantAgentId,
      companyId,
      name: "Quota-limited reviewer",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    seededAgentIds.add(participantAgentId);
    const monitorState = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => parseIssueExecutionState(rows[0]?.executionState ?? null)?.monitor ?? null);
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: participantAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: assigneeAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: monitorState,
      },
    }).where(eq(issues.id, issueId));
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId: participantAgentId, status: "failed",
      errorCode: "provider_quota", finishedAt: new Date("2026-04-11T12:00:00.000Z"),
      contextSnapshot: { issueId },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");
    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);
    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      agentId: participantAgentId,
      reason: "execution_review_participant_recovery",
    });
    const [scheduled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, sourceRunId));
    expect(scheduled).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1 });
    expect(await heartbeat.promoteDueScheduledRetries(scheduled.scheduledRetryAt!)).toMatchObject({ promoted: 1 });
    await heartbeat.resumeQueuedRuns();
    await waitForHeartbeatIdle();
    const participantRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, participantAgentId));
    expect(participantRuns).toHaveLength(2);
    expect(participantRuns.find((run) => run.id === scheduled.id)?.errorCode).not.toBe("issue_assignee_changed");
  });

  it("lets the board trigger a scheduled issue monitor immediately", async () => {
    const { issueId, agentId, nextCheckAt } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const triggeredAt = new Date("2026-04-11T12:00:00.000Z");

    const result = await heartbeat.triggerIssueMonitor(issueId, {
      now: triggeredAt,
      actorType: "user",
      actorId: "local-board",
    });

    expect(result.outcome).toBe("triggered");

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(triggeredAt.toISOString());
    expect(issue.monitorAttemptCount).toBe(1);
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      nextCheckAt: nextCheckAt.toISOString(),
      source: "manual",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .orderBy(activityLog.createdAt);
    expect(activity.map((row) => row.action)).toContain("issue.monitor_triggered");
    const triggerEvent = activity.find((row) => row.action === "issue.monitor_triggered");
    expect(triggerEvent?.actorType).toBe("user");
    expect(triggerEvent?.actorId).toBe("local-board");
    expect(triggerEvent?.details).toMatchObject({
      nextCheckAt: nextCheckAt.toISOString(),
      source: "manual",
    });
  });

  it("clears due monitors that cannot be dispatched and records a skip", async () => {
    const { issueId } = await seedFixture({ agentStatus: "paused" });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "dispatch_skipped",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_skipped");
  });

  it("clears exhausted monitors and queues bounded owner recovery instead of another due check", async () => {
    const { issueId, agentId } = await seedFixture({
      monitorAttemptCount: 1,
      monitor: {
        maxAttempts: 1,
        recoveryPolicy: "wake_owner",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "max_attempts_exhausted",
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_recovery");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      clearReason: "max_attempts_exhausted",
      maxAttempts: 1,
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_exhausted");
    expect(activity).toContain("issue.monitor_recovery_wake_queued");
    expect(activity).not.toContain("issue.monitor_triggered");
  });

  it("clears timed-out monitors and creates a visible recovery issue when requested", async () => {
    const { issueId, companyId } = await seedFixture({
      monitor: {
        timeoutAt: "2026-04-11T12:00:00.000Z",
        recoveryPolicy: "create_recovery_issue",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "timeout_exceeded",
    });

    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, issueId))
      .then((rows) => rows.find((row) => row.companyId === companyId && row.originKind === "stranded_issue_recovery") ?? null);
    expect(recoveryIssue).toMatchObject({
      parentId: issueId,
      priority: "high",
      assigneeAdapterOverrides: null,
    });
    expect(["todo", "in_progress"]).toContain(recoveryIssue?.status);
  });

  describe("pull request triggers", () => {
    const trigger = {
      source: "github" as const,
      event: "check_suite.completed",
      deliveryId: "delivery-1",
      repo: "o/r",
      number: 5,
      headSha: "abc123",
    };

    it("carries the trigger into the wake payload, context snapshot and activity", async () => {
      const { issueId, agentId } = await seedFixture({
        monitor: { pullRequests: [{ owner: "o", repo: "r", number: 5 }] },
      });
      const heartbeat = heartbeatService(db);

      const result = await heartbeat.triggerIssueMonitor(issueId, {
        now: new Date("2026-04-11T12:00:00.000Z"),
        actorType: "system",
        actorId: "github_webhook",
        trigger,
      });
      expect(result.outcome).toBe("triggered");

      const wakeup = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId))
        .then((rows) => rows[0] ?? null);
      expect(wakeup?.reason).toBe("issue_monitor_due");
      expect(wakeup?.payload).toMatchObject({ issueId, trigger });

      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      expect(runs.length).toBeGreaterThan(0);
      expect(runs[0]?.contextSnapshot).toMatchObject({ issueId, trigger });

      const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
      expect(activity.find((row) => row.action === "issue.monitor_triggered")?.details).toMatchObject({ trigger });
    });

    it("logs a trigger-driven wake with its own activity source, not manual", async () => {
      const { issueId, agentId } = await seedFixture();
      await heartbeatService(db).triggerIssueMonitor(issueId, {
        now: new Date("2026-04-11T12:00:00.000Z"),
        actorType: "system",
        actorId: "github_pull_request_poll",
        trigger,
      });

      const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
      const details = activity.find((row) => row.action === "issue.monitor_triggered")?.details as Record<string, unknown>;
      expect(details.source).toBe("pull_request_event");
      expect(details.source).not.toBe("manual");

      const wakeup = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId)).then((rows) => rows[0]);
      expect(wakeup?.payload).toMatchObject({ source: "pull_request_event" });
      const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)).then((rows) => rows[0]);
      expect((run?.contextSnapshot as Record<string, unknown>).manualTrigger).not.toBe(true);
    });

    it("keeps the manual activity source for a trigger without a pull request trigger", async () => {
      const { issueId } = await seedFixture();
      await heartbeatService(db).triggerIssueMonitor(issueId, {
        now: new Date("2026-04-11T12:00:00.000Z"),
        actorType: "user",
        actorId: "local-board",
      });
      const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
      expect(activity.find((row) => row.action === "issue.monitor_triggered")?.details).toMatchObject({ source: "manual" });
    });

    it("copies only the declared trigger fields", async () => {
      const { issueId, agentId } = await seedFixture();
      await heartbeatService(db).triggerIssueMonitor(issueId, {
        now: new Date("2026-04-11T12:00:00.000Z"),
        actorType: "system",
        actorId: "github_webhook",
        trigger: { ...trigger, token: "secret-value" } as typeof trigger,
      });
      const wakeup = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId))
        .then((rows) => rows[0] ?? null);
      expect(JSON.stringify(wakeup?.payload)).not.toContain("secret-value");
    });

    it("does not consume a maxAttempts attempt", async () => {
      const { issueId, agentId } = await seedFixture({
        monitorAttemptCount: 1,
        monitor: { maxAttempts: 1 },
      });
      const heartbeat = heartbeatService(db);

      const result = await heartbeat.triggerIssueMonitor(issueId, {
        now: new Date("2026-04-11T12:00:00.000Z"),
        actorType: "system",
        actorId: "github_webhook",
        trigger,
      });

      expect(result.outcome).toBe("triggered");
      const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(issue.monitorAttemptCount).toBe(1);
      expect(issue.monitorNextCheckAt).toBeNull();
      expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
        status: "triggered",
        attemptCount: 1,
      });
      const wakeup = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId))
        .then((rows) => rows[0] ?? null);
      expect(wakeup?.payload).toMatchObject({ monitorAttemptCount: 1 });
    });

    it("still consumes an attempt for a poll-style trigger without a trigger input", async () => {
      const { issueId } = await seedFixture({ monitorAttemptCount: 1, monitor: { maxAttempts: 5 } });
      await heartbeatService(db).triggerIssueMonitor(issueId, {
        now: new Date("2026-04-11T12:00:00.000Z"),
        actorType: "system",
        actorId: "heartbeat_scheduler",
      });
      const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(issue.monitorAttemptCount).toBe(2);
    });

    it("wakes once per scheduled monitor because the one-shot strip rejects a second trigger", async () => {
      const { issueId, agentId } = await seedFixture();
      const heartbeat = heartbeatService(db);
      const first = await heartbeat.triggerIssueMonitor(issueId, {
        now: new Date("2026-04-11T12:00:00.000Z"),
        actorType: "system",
        actorId: "github_webhook",
        trigger,
      });
      expect(first.outcome).toBe("triggered");

      await expect(
        heartbeat.triggerIssueMonitor(issueId, {
          now: new Date("2026-04-11T12:00:05.000Z"),
          actorType: "system",
          actorId: "github_webhook",
          trigger: { ...trigger, deliveryId: "delivery-2" },
        }),
      ).rejects.toThrow("Issue has no scheduled monitor");

      const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      expect(wakeups).toHaveLength(1);
    });
  });

  describe("pull request polling in the scheduler tick", () => {
    const state = { headSha: "sha-1" };
    const requests: string[] = [];
    const fakeFetch = async (url: string) => {
      requests.push(url);
      const { pathname } = new URL(url);
      if (pathname.endsWith("/pulls/5")) {
        return new Response(
          JSON.stringify({ state: "open", merged: false, mergeable_state: "clean", head: { sha: state.headSha } }),
          { status: 200 },
        );
      }
      if (pathname.includes("/check-suites")) {
        return new Response(JSON.stringify({ check_suites: [{ status: "completed", conclusion: "success" }] }), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    };

    it("baselines, wakes once on a change and logs the pull_request_event source", async () => {
      state.headSha = "sha-1";
      requests.length = 0;
      const { issueId, agentId } = await seedFixture({
        monitor: { pullRequests: [{ owner: "o", repo: "r", number: 5 }] },
      });
      const heartbeat = heartbeatService(db, {
        pullRequestPoll: { fetch: fakeFetch, getToken: async () => "token-value" },
      });

      await heartbeat.tickTimers(new Date("2026-04-11T12:00:00.000Z"));
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId))).toHaveLength(0);

      state.headSha = "sha-2";
      await heartbeat.tickTimers(new Date("2026-04-11T12:04:00.000Z"));
      const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      expect(wakeups).toHaveLength(1);
      expect(wakeups[0]?.payload).toMatchObject({
        trigger: { source: "github", repo: "o/r", number: 5, headSha: "sha-2" },
        source: "pull_request_event",
      });

      await heartbeat.tickTimers(new Date("2026-04-11T12:08:00.000Z"));
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId))).toHaveLength(1);

      const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(issue.monitorNextCheckAt).toBeNull();
      const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
      expect(activity.find((row) => row.action === "issue.monitor_triggered")?.details).toMatchObject({
        source: "pull_request_event",
      });
    });
  });

  it("omits external monitor refs from wake payloads and activity details", async () => {
    const { issueId, agentId } = await seedFixture({
      monitor: {
        serviceName: "Deploy provider",
        externalRef: "https://provider.example/deploy/123?token=secret",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    await heartbeat.tickTimers(tickAt);

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(JSON.stringify(wakeup?.payload)).not.toContain("provider.example");
    expect(wakeup?.payload).not.toHaveProperty("externalRef");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(JSON.stringify(activity.map((row) => row.details))).not.toContain("provider.example");
    expect(activity.find((row) => row.action === "issue.monitor_triggered")?.details).not.toHaveProperty("externalRef");
  });
  describe("sanitizeIssueMonitorTrigger", () => {
    const base = { source: "github" as const, event: "pull_request", repo: "o/r", number: 5 };

    it("lower-cases a valid owner/repo and keeps a positive safe integer", () => {
      expect(sanitizeIssueMonitorTrigger({ ...base, repo: "Owner/Repo.js" })).toMatchObject({ repo: "owner/repo.js", number: 5 });
    });

    it.each(["not-a-repo", "a/b/c", "../r", "o/..", "o/", "/r", "o/r?x=1", "o/r r", ""])("rejects repo %j", (repo) => {
      expect(() => sanitizeIssueMonitorTrigger({ ...base, repo })).toThrow();
    });

    it.each([["5"], [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1], [Number.NaN], [null]])("rejects number %j", (number) => {
      expect(() => sanitizeIssueMonitorTrigger({ ...base, number: number as number })).toThrow();
    });

    it("rejects a bad trigger before the monitor is claimed", async () => {
      const { issueId, agentId } = await seedFixture();
      await expect(
        heartbeatService(db).triggerIssueMonitor(issueId, {
          now: new Date("2026-04-11T12:00:00.000Z"),
          actorType: "system",
          actorId: "github_webhook",
          trigger: { ...base, repo: "not-a-repo" },
        }),
      ).rejects.toThrow();
      const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(issue.monitorNextCheckAt).not.toBeNull();
      expect(issue.monitorWakeRequestedAt).toBeNull();
      const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      expect(wakeups).toHaveLength(0);
    });
  });

  describe("GitHub webhook monitor sink", () => {
    const pr = (action: string, extra: Record<string, unknown> = {}) => ({
      action,
      repository: { id: 1, full_name: "Acme/Widgets" },
      pull_request: { number: 7, head: { sha: "headsha1" }, merged: false },
      ...extra,
    });
    const events: Array<[string, string, Record<string, unknown>]> = [
      ["pull_request", "pull_request:synchronize", pr("synchronize")],
      [
        "check_suite",
        "check_suite:completed",
        {
          action: "completed",
          repository: { id: 1, full_name: "Acme/Widgets" },
          check_suite: { head_sha: "headsha1", pull_requests: [{ number: 7, head: { sha: "headsha1" }, base: { repo: { id: 1 } } }] },
        },
      ],
      ["pull_request_review", "pull_request_review:submitted", pr("submitted", { review: { id: 3 } })],
      ["issue_comment", "issue_comment:created", {
        action: "created",
        repository: { id: 1, full_name: "Acme/Widgets" },
        issue: { number: 7, pull_request: { url: "https://api.github.com/repos/Acme/Widgets/pulls/7" } },
        comment: { id: 9, body: "private text" },
      }],
      ["pull_request_review_comment", "pull_request_review_comment:created", pr("created", { comment: { id: 10, body: "private text" } })],
    ];

    it.each(events)("wakes the matching monitor once for %s", async (eventType, expectedEvent, payload) => {
      const { companyId, issueId, agentId } = await seedFixture({
        monitor: { pullRequests: [{ owner: "acme", repo: "widgets", number: 7 }] },
      });
      const other = await seedFixture({
        monitor: { pullRequests: [{ owner: "acme", repo: "widgets", number: 8 }] },
      });
      const sink = makeSink();

      const result = await sink.handle({ companyId, endpointId: await seedEndpoint(companyId, agentId), eventType, deliveryId: `d-${eventType}`, payload });
      expect(result).toMatchObject({ outcome: "processed", woken: 1 });

      const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      expect(wakeups).toHaveLength(1);
      expect(wakeups[0]?.payload).toMatchObject({
        issueId,
        source: "pull_request_event",
        trigger: { source: "github", event: expectedEvent, deliveryId: `d-${eventType}`, repo: "acme/widgets", number: 7 },
      });
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, other.agentId))).toHaveLength(0);

      const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
      const details = activity.find((row) => row.action === "issue.monitor_triggered")?.details as Record<string, unknown>;
      expect(details.source).toBe("pull_request_event");
      const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)).then((rows) => rows[0]);
      expect(run?.contextSnapshot).toMatchObject({ trigger: { event: expectedEvent } });
      expect((run?.contextSnapshot as Record<string, unknown>).manualTrigger).not.toBe(true);
    });

    it("does not wake twice for a redelivery with the same delivery id", async () => {
      const { companyId, issueId, agentId } = await seedFixture({
        monitor: { pullRequests: [{ owner: "acme", repo: "widgets", number: 7 }] },
      });
      const sink = makeSink();
      const endpointId = await seedEndpoint(companyId, agentId);
      const input = { companyId, endpointId, eventType: "pull_request", deliveryId: "same-delivery", payload: pr("synchronize") };
      expect(await sink.handle(input)).toMatchObject({ outcome: "processed", woken: 1 });

      // Reschedule so only the delivery id, not the one-shot strip, can stop a second wake.
      await db.update(issues).set({ monitorNextCheckAt: new Date("2026-12-01T00:00:00.000Z") }).where(eq(issues.id, issueId));
      expect(await sink.handle(input)).toMatchObject({ outcome: "duplicate", woken: 0 });
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId))).toHaveLength(1);
    });

    it("strips the monitor so polling does not wake it again", async () => {
      const { companyId, issueId, agentId } = await seedFixture({
        monitor: { pullRequests: [{ owner: "acme", repo: "widgets", number: 7 }] },
      });
      expect((await listWatchedMonitorPullRequests(db)).map((row) => row.issueId)).toContain(issueId);
      await makeSink().handle({ companyId, endpointId: await seedEndpoint(companyId, agentId), eventType: "pull_request", deliveryId: "d1", payload: pr("closed") });
      expect((await listWatchedMonitorPullRequests(db)).map((row) => row.issueId)).not.toContain(issueId);
    });

    it("never wakes a monitor of another company", async () => {
      const mine = await seedFixture({ monitor: { pullRequests: [{ owner: "acme", repo: "widgets", number: 7 }] } });
      const theirs = await seedFixture({ monitor: { pullRequests: [{ owner: "acme", repo: "widgets", number: 7 }] } });
      const result = await makeSink().handle({ companyId: mine.companyId, endpointId: await seedEndpoint(mine.companyId, mine.agentId), eventType: "pull_request", deliveryId: "d1", payload: pr("opened") });
      expect(result.woken).toBe(1);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, theirs.agentId))).toHaveLength(0);
    });

    it.each([
      ["pull_request", pr("labeled")],
      ["pull_request", pr("synchronize", { repository: { id: 1, full_name: "not-a-repo" } })],
      ["pull_request", pr("synchronize", { pull_request: { number: "7", head: { sha: "x" } } })],
      ["pull_request", pr("synchronize", { pull_request: { number: -7, head: { sha: "x" } } })],
      ["check_suite", { action: "requested", repository: { id: 1, full_name: "Acme/Widgets" }, check_suite: { pull_requests: [{ number: 7 }] } }],
      ["pull_request_review", pr("dismissed")],
      ["issue_comment", { action: "created", repository: { id: 1, full_name: "Acme/Widgets" }, issue: { number: 7 } }],
      ["issue_comment", { action: "edited", repository: { id: 1, full_name: "Acme/Widgets" }, issue: { number: 7, pull_request: {} } }],
      ["push", pr("synchronize")],
    ])("ignores %s payloads that carry no valid pull request event", async (eventType, payload) => {
      const { companyId, agentId } = await seedFixture({
        monitor: { pullRequests: [{ owner: "acme", repo: "widgets", number: 7 }] },
      });
      const result = await makeSink().handle({ companyId, endpointId: await seedEndpoint(companyId, agentId), eventType, deliveryId: "d1", payload });
      expect(result).toMatchObject({ outcome: "ignored", woken: 0 });
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId))).toHaveLength(0);
    });

    it("keeps no comment text in the delivery receipt", async () => {
      const { companyId, agentId } = await seedFixture({
        monitor: { pullRequests: [{ owner: "acme", repo: "widgets", number: 7 }] },
      });
      const endpointId = await seedEndpoint(companyId, agentId);
      await makeSink().handle({ companyId, endpointId, eventType: "issue_comment", deliveryId: "d1", payload: events[3]![2] });
      const rows = await db.execute(sql`select payload::text as payload from chat_actions where endpoint_id = ${endpointId}`);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain("private text");
    });
  });
  describe("native pull request watching is on by default and can be switched off", () => {
    const state = { headSha: "sha-1" };
    const requests: string[] = [];
    const fakeFetch = async (url: string) => {
      requests.push(url);
      const { pathname } = new URL(url);
      if (pathname.endsWith("/pulls/5")) {
        return new Response(
          JSON.stringify({ state: "open", merged: false, mergeable_state: "clean", head: { sha: state.headSha } }),
          { status: 200 },
        );
      }
      if (pathname.includes("/check-suites")) {
        return new Response(JSON.stringify({ check_suites: [{ status: "completed", conclusion: "success" }] }), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    };
    const pullRequests = [{ owner: "o", repo: "r", number: 5 }];
    const webhookPayload = {
      action: "synchronize",
      repository: { id: 1, full_name: "O/R" },
      pull_request: { number: 5, head: { sha: "headsha1" }, merged: false },
    };
    const secretsDir = path.join(os.tmpdir(), `paperclip-pr-watch-default-${randomUUID()}`);
    const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;

    beforeAll(() => {
      mkdirSync(secretsDir, { recursive: true });
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsDir, "master.key");
    });

    afterAll(() => {
      if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
      else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
      rmSync(secretsDir, { recursive: true, force: true });
    });

    afterEach(async () => {
      await db.delete(instanceSettings);
      await db.delete(companySecrets);
    });

    async function wakeCount(agentId: string) {
      return (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId))).length;
    }

    async function pollUntilChange(heartbeat: ReturnType<typeof heartbeatService>) {
      state.headSha = "sha-1";
      requests.length = 0;
      await heartbeat.tickTimers(new Date("2026-04-11T12:00:00.000Z"));
      state.headSha = "sha-2";
      await heartbeat.tickTimers(new Date("2026-04-11T12:04:00.000Z"));
    }

    it("wakes a company created after boot that has only a GitHub token secret, through polling", async () => {
      const { companyId, agentId } = await seedFixture({ monitor: { pullRequests } });
      await secretService(db).create(companyId, { name: "GITHUB_TOKEN", provider: "local_encrypted", value: "ghp_fixture_value" });
      const heartbeat = heartbeatService(db, { pullRequestPoll: { fetch: fakeFetch } });

      await pollUntilChange(heartbeat);

      expect(await wakeCount(agentId)).toBe(1);
    });

    it("wakes a company created after boot that has only a GitHub chat endpoint, through the webhook", async () => {
      const { companyId, agentId } = await seedFixture({ monitor: { pullRequests } });

      const result = await makeSink().handle({
        companyId,
        endpointId: await seedEndpoint(companyId, agentId),
        eventType: "pull_request",
        deliveryId: "created-after-boot",
        payload: webhookPayload,
      });

      expect(result).toMatchObject({ outcome: "processed", woken: 1 });
      expect(await wakeCount(agentId)).toBe(1);
    });

    async function switchOff(level: "instance" | "company" | "agent", target: { companyId: string; agentId: string }) {
      if (level === "instance") await instanceSettingsService(db).updateGeneral({ prMonitorWatching: false });
      if (level === "company") await db.update(companies).set({ prMonitorWatching: false }).where(eq(companies.id, target.companyId));
      if (level === "agent") {
        await db
          .update(agents)
          .set({ runtimeConfig: sql`${agents.runtimeConfig} || '{"prMonitorWatching": false}'::jsonb` })
          .where(eq(agents.id, target.agentId));
      }
    }

    it.each(["instance", "company", "agent"] as const)(
      "stops polling and webhook wakes when switched off for the %s",
      async (level) => {
        const target = await seedFixture({ monitor: { pullRequests } });
        await secretService(db).create(target.companyId, { name: "GITHUB_TOKEN", provider: "local_encrypted", value: "ghp_fixture_value" });
        await switchOff(level, target);
        const heartbeat = heartbeatService(db, { pullRequestPoll: { fetch: fakeFetch } });

        await pollUntilChange(heartbeat);
        const result = await makeSink().handle({
          companyId: target.companyId,
          endpointId: await seedEndpoint(target.companyId, target.agentId),
          eventType: "pull_request",
          deliveryId: `off-${level}`,
          payload: webhookPayload,
        });

        expect(requests).toEqual([]);
        expect(result).toMatchObject({ woken: 0 });
        expect(await wakeCount(target.agentId)).toBe(0);
      },
    );

    it("keeps watching other companies when one company opts out", async () => {
      const optedOut = await seedFixture({ monitor: { pullRequests } });
      const other = await seedFixture({ monitor: { pullRequests } });
      await switchOff("company", optedOut);
      await secretService(db).create(other.companyId, { name: "GITHUB_TOKEN", provider: "local_encrypted", value: "ghp_fixture_value" });
      const heartbeat = heartbeatService(db, { pullRequestPoll: { fetch: fakeFetch } });

      await pollUntilChange(heartbeat);

      expect(await wakeCount(optedOut.agentId)).toBe(0);
      expect(await wakeCount(other.agentId)).toBe(1);
    });

    it("keeps watching off when the instance is off, even if the company and agent say on", async () => {
      const target = await seedFixture({ monitor: { pullRequests } });
      await db.update(companies).set({ prMonitorWatching: true }).where(eq(companies.id, target.companyId));
      await db
        .update(agents)
        .set({ runtimeConfig: sql`${agents.runtimeConfig} || '{"prMonitorWatching": true}'::jsonb` })
        .where(eq(agents.id, target.agentId));
      await instanceSettingsService(db).updateGeneral({ prMonitorWatching: false });
      await secretService(db).create(target.companyId, { name: "GITHUB_TOKEN", provider: "local_encrypted", value: "ghp_fixture_value" });
      const heartbeat = heartbeatService(db, { pullRequestPoll: { fetch: fakeFetch } });

      await pollUntilChange(heartbeat);
      const result = await makeSink().handle({
        companyId: target.companyId,
        endpointId: await seedEndpoint(target.companyId, target.agentId),
        eventType: "pull_request",
        deliveryId: "instance-off-company-on",
        payload: webhookPayload,
      });

      expect(requests).toEqual([]);
      expect(result).toMatchObject({ woken: 0 });
      expect(await wakeCount(target.agentId)).toBe(0);
    });

    it("resumes watching when the instance switch is turned back on", async () => {
      const target = await seedFixture({ monitor: { pullRequests } });
      await instanceSettingsService(db).updateGeneral({ prMonitorWatching: false });
      await instanceSettingsService(db).updateGeneral({ prMonitorWatching: true });

      const result = await makeSink().handle({
        companyId: target.companyId,
        endpointId: await seedEndpoint(target.companyId, target.agentId),
        eventType: "pull_request",
        deliveryId: "back-on",
        payload: webhookPayload,
      });

      expect(result).toMatchObject({ woken: 1 });
    });
  });
});
