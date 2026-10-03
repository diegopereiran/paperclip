import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  issueRelations,
  issues,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { recoveryService } from "../services/recovery/service.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres deferred children-completed wake tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("recovery reconcileDeferredChildrenCompletedWake", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deferred-children-wake-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(workspaceOperations);
    await db.delete(agentWakeupRequests);
    await db.delete(activityLog);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(completedAt = new Date("2026-05-23T22:01:00.000Z")) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    const parentId = randomUUID();
    const childId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Delivery",
      role: "manager",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Project",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Ticket worktree",
      status: "active",
      providerType: "git_worktree",
    });
    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        title: "Parent",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: childId,
        companyId,
        parentId,
        title: "Child",
        status: "done",
        priority: "medium",
        executionWorkspaceId,
        completedAt,
      },
    ]);
    // The child's run prepared the worktree; sync-back has not landed.
    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: childId,
      phase: "worktree_prepare",
      status: "succeeded",
      startedAt: new Date("2026-05-23T22:00:00.000Z"),
    });
    return { companyId, agentId, executionWorkspaceId, parentId, childId };
  }

  function buildService() {
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }) as never);
    return { enqueueWakeup, recovery: recoveryService(db, { enqueueWakeup }) };
  }

  it("sends no parent wake while the child's sync-back is pending, then exactly one after finalize", async () => {
    const { companyId, agentId, executionWorkspaceId, parentId, childId } = await seed();
    const { enqueueWakeup, recovery } = buildService();

    // Mid-run: the route-time check defers, and so does the reconciler.
    expect(await issueService(db).getWakeableParentAfterChildCompletion(parentId)).toBeNull();
    await expect(
      recovery.reconcileDeferredChildrenCompletedWake({
        runId: null,
        companyId,
        completedChildIssueId: childId,
      }),
    ).resolves.toMatchObject({ notReady: 1, healed: 0 });
    expect(enqueueWakeup).not.toHaveBeenCalled();

    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: childId,
      phase: "workspace_finalize",
      status: "succeeded",
      startedAt: new Date("2026-05-23T22:05:00.000Z"),
    });

    const input = { runId: null, companyId, completedChildIssueId: childId };
    await expect(recovery.reconcileDeferredChildrenCompletedWake(input)).resolves.toMatchObject({
      healed: 1,
    });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        reason: "issue_children_completed",
        idempotencyKey: `issue_children_completed:${parentId}:${childId}`,
        payload: expect.objectContaining({
          issueId: parentId,
          completedChildIssueId: childId,
          childIssueIds: [childId],
        }),
        contextSnapshot: expect.objectContaining({
          issueId: parentId,
          wakeReason: "issue_children_completed",
        }),
      }),
    );

    // A repeat finalize pass must not send a second wake.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_children_completed",
      status: "queued",
      payload: { issueId: parentId, completedChildIssueId: childId },
    });
    await expect(recovery.reconcileDeferredChildrenCompletedWake(input)).resolves.toMatchObject({
      healed: 0,
      existingWakeSkipped: 1,
    });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("does not send a second wake when the route already woke the parent for this completion", async () => {
    const { companyId, agentId, executionWorkspaceId, parentId, childId } = await seed();
    const { enqueueWakeup, recovery } = buildService();
    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: childId,
      phase: "workspace_finalize",
      status: "succeeded",
      startedAt: new Date("2026-05-23T22:05:00.000Z"),
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_children_completed",
      status: "completed",
      payload: { issueId: parentId, completedChildIssueId: childId },
      createdAt: new Date("2026-05-23T22:02:00.000Z"),
    });

    await expect(
      recovery.reconcileDeferredChildrenCompletedWake({
        runId: null,
        companyId,
        completedChildIssueId: childId,
      }),
    ).resolves.toMatchObject({ healed: 0, existingWakeSkipped: 1 });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("wakes the parent again when the child was reopened and completed after the earlier wake", async () => {
    const { companyId, agentId, executionWorkspaceId, parentId, childId } = await seed();
    const { enqueueWakeup, recovery } = buildService();
    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: childId,
      phase: "workspace_finalize",
      status: "succeeded",
      startedAt: new Date("2026-05-23T22:05:00.000Z"),
    });
    // A wake for the first completion, sent before the child's latest completedAt.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_children_completed",
      status: "completed",
      payload: { issueId: parentId, completedChildIssueId: childId },
      createdAt: new Date("2026-05-23T21:00:00.000Z"),
    });

    await expect(
      recovery.reconcileDeferredChildrenCompletedWake({
        runId: null,
        companyId,
        completedChildIssueId: childId,
      }),
    ).resolves.toMatchObject({ healed: 1 });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("recovers the wake after a failed finalize when a later finalize clears the barrier", async () => {
    const { companyId, agentId, executionWorkspaceId, parentId, childId } = await seed(
      new Date(Date.now() - 60 * 60 * 1000),
    );
    const { enqueueWakeup, recovery } = buildService();

    // The child's own finalize failed: the finalize hook finds the parent not ready.
    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: childId,
      phase: "workspace_finalize",
      status: "failed",
      startedAt: new Date("2026-05-23T22:05:00.000Z"),
    });
    await expect(
      recovery.reconcileDeferredChildrenCompletedWake({
        runId: null,
        companyId,
        completedChildIssueId: childId,
      }),
    ).resolves.toMatchObject({ notReady: 1, healed: 0 });
    await expect(recovery.reconcileDeferredChildrenCompletedWakes({ companyId })).resolves.toMatchObject({
      healed: 0,
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();

    // A later run on the same workspace finalizes successfully. The finalize
    // hook never re-runs for the child, so the periodic sweep must send the wake.
    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: null,
      phase: "workspace_finalize",
      status: "succeeded",
      startedAt: new Date("2026-05-23T22:10:00.000Z"),
    });
    await expect(recovery.reconcileDeferredChildrenCompletedWakes({ companyId })).resolves.toMatchObject({
      healed: 1,
    });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        reason: "issue_children_completed",
        payload: expect.objectContaining({ issueId: parentId, completedChildIssueId: childId }),
      }),
    );

    // The sweep repeats every tick: once the wake exists it must stay quiet.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_children_completed",
      status: "queued",
      payload: { issueId: parentId, completedChildIssueId: childId },
    });
    await expect(recovery.reconcileDeferredChildrenCompletedWakes({ companyId })).resolves.toMatchObject({
      healed: 0,
    });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });
});
