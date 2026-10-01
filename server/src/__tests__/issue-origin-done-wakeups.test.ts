import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  agentRuntimeState,
  budgetPolicies,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acknowledged origin wake.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";
import { runningProcesses } from "../adapters/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres origin-done wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("wake the issue whose run created a done issue", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-origin-done-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    vi.clearAllMocks();
    runningProcesses.clear();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(workspaceOperations);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `O${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: randomUUID(),
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Priya",
      role: "engineer",
      status: "idle",
      adapterType: "test_adapter",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId, issuePrefix };
  }

  /**
   * One agent run on `originIssueId` created `gateIssueId`. The gate carries no
   * parent link and no blocker edge: the only trace is `originRunId`.
   */
  async function seedGate(opts: {
    originStatus?: string;
    originAssignee?: "agent" | "user" | null;
    gateStatus?: string;
    gateOriginKind?: string;
    gateParent?: "origin" | null;
    gateBlocksOrigin?: boolean;
    gateCompletedAt?: Date | null;
    runIssueKey?: "issueId" | "taskId" | "none";
    company?: Awaited<ReturnType<typeof seedCompany>>;
  } = {}) {
    const company = opts.company ?? (await seedCompany());
    const { companyId, agentId, issuePrefix } = company;
    const originIssueId = randomUUID();
    const gateIssueId = randomUUID();
    const runId = randomUUID();
    const originAssignee = opts.originAssignee === undefined ? "agent" : opts.originAssignee;

    await db.insert(issues).values({
      id: originIssueId,
      companyId,
      title: "Implementation under review",
      status: opts.originStatus ?? "in_review",
      priority: "medium",
      assigneeAgentId: originAssignee === "agent" ? agentId : null,
      assigneeUserId: originAssignee === "user" ? "board-user" : null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      contextSnapshot:
        opts.runIssueKey === "none"
          ? {}
          : { [opts.runIssueKey ?? "issueId"]: originIssueId },
    });
    await db.insert(issues).values({
      id: gateIssueId,
      companyId,
      parentId: opts.gateParent === "origin" ? originIssueId : null,
      title: "Merge gate",
      status: opts.gateStatus ?? "done",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
      originKind: opts.gateOriginKind ?? "manual",
      originRunId: runId,
      completedAt:
        opts.gateCompletedAt === undefined ? new Date() : opts.gateCompletedAt,
    });
    if (opts.gateBlocksOrigin) {
      await db.insert(issueRelations).values({
        companyId,
        issueId: gateIssueId,
        relatedIssueId: originIssueId,
        type: "blocks",
      });
    }
    return { ...company, originIssueId, gateIssueId, runId };
  }

  async function originWakes(companyId: string) {
    return db
      .select({
        agentId: agentWakeupRequests.agentId,
        status: agentWakeupRequests.status,
        payload: agentWakeupRequests.payload,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.reason, "issue_origin_done"),
        ),
      );
  }

  describe("issueService.getWakeableOriginIssueAfterDone", () => {
    it("returns the open agent-assigned issue whose run created the done issue", async () => {
      const { agentId, originIssueId, gateIssueId } = await seedGate();

      await expect(
        issueService(db).getWakeableOriginIssueAfterDone(gateIssueId),
      ).resolves.toEqual({
        id: originIssueId,
        assigneeAgentId: agentId,
        doneIssueId: gateIssueId,
      });
    });

    it("reads the origin issue from a run snapshot that uses taskId", async () => {
      const { originIssueId, gateIssueId } = await seedGate({ runIssueKey: "taskId" });

      await expect(
        issueService(db).getWakeableOriginIssueAfterDone(gateIssueId),
      ).resolves.toMatchObject({ id: originIssueId });
    });

    it.each(["todo", "in_progress", "in_review", "blocked"])(
      "treats an origin issue in %s as open",
      async (originStatus) => {
        const { originIssueId, gateIssueId } = await seedGate({ originStatus });

        await expect(
          issueService(db).getWakeableOriginIssueAfterDone(gateIssueId),
        ).resolves.toMatchObject({ id: originIssueId });
      },
    );

    it.each(["backlog", "done", "cancelled"])(
      "skips an origin issue in %s",
      async (originStatus) => {
        const { gateIssueId } = await seedGate({ originStatus });

        await expect(
          issueService(db).getWakeableOriginIssueAfterDone(gateIssueId),
        ).resolves.toBeNull();
      },
    );

    it("skips an origin issue assigned to a user", async () => {
      const { gateIssueId } = await seedGate({ originAssignee: "user" });

      await expect(
        issueService(db).getWakeableOriginIssueAfterDone(gateIssueId),
      ).resolves.toBeNull();
    });

    it("skips an unassigned origin issue", async () => {
      const { gateIssueId } = await seedGate({ originAssignee: null });

      await expect(
        issueService(db).getWakeableOriginIssueAfterDone(gateIssueId),
      ).resolves.toBeNull();
    });

    it("skips an issue created by a routine execution", async () => {
      const { gateIssueId } = await seedGate({ gateOriginKind: "routine_execution" });

      await expect(
        issueService(db).getWakeableOriginIssueAfterDone(gateIssueId),
      ).resolves.toBeNull();
    });

    it("skips when the origin issue is the parent of the done issue", async () => {
      const { gateIssueId } = await seedGate({ gateParent: "origin" });

      await expect(
        issueService(db).getWakeableOriginIssueAfterDone(gateIssueId),
      ).resolves.toBeNull();
    });

    it("skips when the origin issue is blocked by the done issue", async () => {
      const { gateIssueId } = await seedGate({ gateBlocksOrigin: true });

      await expect(
        issueService(db).getWakeableOriginIssueAfterDone(gateIssueId),
      ).resolves.toBeNull();
    });

    it("skips an issue that is not done", async () => {
      const { gateIssueId } = await seedGate({ gateStatus: "in_progress" });

      await expect(
        issueService(db).getWakeableOriginIssueAfterDone(gateIssueId),
      ).resolves.toBeNull();
    });

    it("skips when the run snapshot names no issue", async () => {
      const { gateIssueId } = await seedGate({ runIssueKey: "none" });

      await expect(
        issueService(db).getWakeableOriginIssueAfterDone(gateIssueId),
      ).resolves.toBeNull();
    });

    it("skips when the creating run belongs to a different company", async () => {
      const foreign = await seedGate();
      const local = await seedCompany();
      const gateIssueId = randomUUID();
      await db.insert(issues).values({
        id: gateIssueId,
        companyId: local.companyId,
        title: "Gate pointing at a foreign run",
        status: "done",
        priority: "medium",
        issueNumber: 1,
        identifier: `${local.issuePrefix}-1`,
        originRunId: foreign.runId,
        completedAt: new Date(),
      });

      await expect(
        issueService(db).getWakeableOriginIssueAfterDone(gateIssueId),
      ).resolves.toBeNull();
    });

    it("skips when the origin issue belongs to a different company than the run", async () => {
      const first = await seedGate();
      const second = await seedCompany();
      await db
        .update(issues)
        .set({ companyId: second.companyId })
        .where(eq(issues.id, first.originIssueId));

      await expect(
        issueService(db).getWakeableOriginIssueAfterDone(first.gateIssueId),
      ).resolves.toBeNull();
    });
  });

  describe("heartbeat.reconcileIssueOriginDoneWakes", () => {
    it("wakes the origin issue once for a done issue that no route wake covered", async () => {
      const { companyId, agentId, originIssueId, gateIssueId } = await seedGate();
      const heartbeat = heartbeatService(db);

      const first = await heartbeat.reconcileIssueOriginDoneWakes();

      expect(first.healed).toBe(1);
      expect(first.issueIds).toEqual([originIssueId]);
      const wakes = await originWakes(companyId);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toMatchObject({
        agentId,
        idempotencyKey: `issue_origin_done:${originIssueId}:${gateIssueId}`,
        payload: expect.objectContaining({
          issueId: originIssueId,
          doneIssueId: gateIssueId,
        }),
      });

      await heartbeat.drainActiveRunExecutions();
      const second = await heartbeat.reconcileIssueOriginDoneWakes();

      expect(second.healed).toBe(0);
      expect(second.existingWakeSkipped).toBe(1);
      expect(await originWakes(companyId)).toHaveLength(1);
    });

    it("does not wake again when the route already queued the same wake", async () => {
      const { companyId, agentId, originIssueId, gateIssueId } = await seedGate();
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_origin_done",
        payload: { issueId: originIssueId, doneIssueId: gateIssueId },
        status: "completed",
        idempotencyKey: `issue_origin_done:${originIssueId}:${gateIssueId}`,
      });

      const result = await heartbeatService(db).reconcileIssueOriginDoneWakes();

      expect(result.healed).toBe(0);
      expect(result.existingWakeSkipped).toBe(1);
      expect(await originWakes(companyId)).toHaveLength(1);
    });

    it.each([
      ["a routine execution", { gateOriginKind: "routine_execution" }],
      ["a child of the origin issue", { gateParent: "origin" as const }],
      ["a blocker of the origin issue", { gateBlocksOrigin: true }],
      ["a closed origin issue", { originStatus: "done" }],
      ["a user-assigned origin issue", { originAssignee: "user" as const }],
    ])("does not wake for %s", async (_label, seedOptions) => {
      const { companyId } = await seedGate(seedOptions);

      const result = await heartbeatService(db).reconcileIssueOriginDoneWakes();

      expect(result.healed).toBe(0);
      expect(await originWakes(companyId)).toHaveLength(0);
    });

    it("ignores an issue completed before the lookback window", async () => {
      const { companyId } = await seedGate({
        gateCompletedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      });

      const result = await heartbeatService(db).reconcileIssueOriginDoneWakes();

      expect(result.checked).toBe(0);
      expect(result.healed).toBe(0);
      expect(await originWakes(companyId)).toHaveLength(0);
    });

    it("heals every company, including one created after the others, with no setup", async () => {
      const first = await seedGate();
      const heartbeat = heartbeatService(db);
      await heartbeat.reconcileIssueOriginDoneWakes();
      await heartbeat.drainActiveRunExecutions();

      const later = await seedGate();
      const result = await heartbeat.reconcileIssueOriginDoneWakes();

      expect(result.healed).toBe(1);
      expect(result.issueIds).toEqual([later.originIssueId]);
      expect(await originWakes(first.companyId)).toHaveLength(1);
      expect(await originWakes(later.companyId)).toHaveLength(1);
    });
  });
});
