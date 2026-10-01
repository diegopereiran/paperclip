import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issues,
} from "@paperclipai/db";
import { currentAgentProcessPolicy, type AgentProcessPolicy } from "@paperclipai/adapter-utils/agent-process-policy";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { agentService } from "../services/agents.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { resolveAgentProcessPolicy } from "../services/agent-process-policy-guard.ts";
import { runningProcesses } from "../adapters/index.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const seenPolicies = vi.hoisted(() => [] as Array<AgentProcessPolicy | undefined>);
const mockAdapterExecute = vi.hoisted(() => vi.fn());

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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function waitForRun(db: ReturnType<typeof createDb>, runId: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
    if (run && run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
}

describeEmbeddedPostgres("agent process policy resolution", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-process-policy-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    seenPolicies.length = 0;
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await tempDb?.cleanup();
  }, 60_000);

  function recordPolicyAndSucceed() {
    mockAdapterExecute.mockImplementation(async () => {
      seenPolicies.push(currentAgentProcessPolicy());
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Process policy resolution test run.",
        provider: "test",
        model: "test-model",
      };
    });
  }

  async function createCompanyAndAgent(runtimeConfig: Record<string, unknown> = {}) {
    const companyId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: ownerUserId,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "owner",
      status: "active",
    });
    const agent = await agentService(db).create(companyId, {
      name: "Coder",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 }, ...runtimeConfig },
      budgetMonthlyCents: 0,
      metadata: {},
      status: "idle",
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
    });
    return { companyId, ownerUserId, agent };
  }

  async function runOnce(agentId: string, ownerUserId: string) {
    const run = await heartbeat.wakeup(agentId, {
      manualUserWake: true,
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: ownerUserId,
    });
    expect((await waitForRun(db, run!.id))?.status).toBe("succeeded");
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
  }

  const instancePolicy: AgentProcessPolicy = {
    mode: "enforce",
    filesystem: { scope: "workspace", rw: ["/srv/policy-test/cache"], gitDir: "auto" },
    network: { scope: "deny" },
  };

  it("gives a company and an agent created after the instance setting the instance policy with no setup", async () => {
    await instanceSettingsService(db).updateGeneral({ agentProcessPolicy: instancePolicy });

    const { agent, ownerUserId } = await createCompanyAndAgent();
    expect((agent.runtimeConfig as Record<string, unknown>).processPolicy).toBeUndefined();

    recordPolicyAndSucceed();
    await runOnce(agent.id, ownerUserId);

    expect(seenPolicies).toEqual([instancePolicy]);
    const general = await instanceSettingsService(db).getGeneral();
    expect(
      resolveAgentProcessPolicy({ instance: general.agentProcessPolicy, agentRuntimeConfig: agent.runtimeConfig }),
    ).toEqual(instancePolicy);
  });

  it("lets an agent narrow scalars and add to the lists, per run", async () => {
    await instanceSettingsService(db).updateGeneral({ agentProcessPolicy: instancePolicy });
    const { agent, ownerUserId } = await createCompanyAndAgent({
      processPolicy: {
        filesystem: { rw: ["/srv/policy-test/agent-only"], ro: ["/srv/policy-test/docs"] },
        network: { scope: "allowlist", allowlist: ["api.example.org"] },
      },
    });

    recordPolicyAndSucceed();
    await runOnce(agent.id, ownerUserId);

    expect(seenPolicies).toEqual([
      {
        mode: "enforce",
        filesystem: {
          scope: "workspace",
          gitDir: "auto",
          rw: ["/srv/policy-test/cache", "/srv/policy-test/agent-only"],
          ro: ["/srv/policy-test/docs"],
        },
        network: { scope: "allowlist", allowlist: ["api.example.org"] },
      },
    ]);
  });

  it("resolves to an empty policy (mode off) when no layer sets one", async () => {
    const { agent, ownerUserId } = await createCompanyAndAgent();
    recordPolicyAndSucceed();
    await runOnce(agent.id, ownerUserId);
    expect(seenPolicies).toEqual([{}]);
    expect(seenPolicies[0]?.mode).toBeUndefined();
  });
});
