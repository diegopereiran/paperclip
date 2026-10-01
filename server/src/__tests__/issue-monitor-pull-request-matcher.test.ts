import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, agents, issues, issueWorkProducts } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";
import { findIssuesWithMonitorForPullRequest } from "../services/issue-monitor-pull-requests.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres PR monitor matcher tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("findIssuesWithMonitorForPullRequest", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-monitor-pr-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  let issueCounter = 0;

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Matcher Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Matcher Bot",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId, issuePrefix };
  }

  async function seedIssue(
    company: { companyId: string; agentId: string; issuePrefix: string },
    input: {
      monitor?: Record<string, unknown> | null;
      scheduled?: boolean;
      status?: "in_progress" | "in_review" | "blocked" | "todo";
      assigneeUserId?: string | null;
      notes?: string | null;
    } = {},
  ) {
    const id = randomUUID();
    issueCounter += 1;
    const nextCheckAt = "2026-12-01T12:00:00.000Z";
    const policy = input.monitor === null
      ? null
      : normalizeIssueExecutionPolicy({ monitor: { nextCheckAt, notes: input.notes ?? null, ...(input.monitor ?? {}) } }, { source: "client" });
    await db.insert(issues).values({
      id,
      companyId: company.companyId,
      title: "Watch a PR",
      status: input.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: company.agentId,
      assigneeUserId: input.assigneeUserId ?? null,
      issueNumber: issueCounter,
      identifier: `${company.issuePrefix}-${issueCounter}`,
      executionPolicy: policy as unknown as Record<string, unknown> | null,
      monitorNextCheckAt: input.scheduled === false ? null : new Date(nextCheckAt),
      monitorNotes: input.notes ?? null,
      monitorScheduledBy: "assignee",
    });
    return id;
  }

  const target = { owner: "Open", repo: "Repo", number: 12 };

  it("finds a scheduled monitor by its externalRef, stored as coordinates", async () => {
    const company = await seedCompany();
    const issueId = await seedIssue(company, {
      monitor: { externalRef: "https://github.com/open/repo/pull/12?token=secret" },
    });

    const matches = await findIssuesWithMonitorForPullRequest(db, { companyId: company.companyId, ...target });

    expect(matches).toEqual([{ issueId, identifier: expect.any(String), matchedBy: ["pullRequests"] }]);
  });

  it("finds a scheduled monitor by its notes", async () => {
    const company = await seedCompany();
    const issueId = await seedIssue(company, { monitor: null, notes: "Waiting for open/repo#12 to go green" });

    const matches = await findIssuesWithMonitorForPullRequest(db, { companyId: company.companyId, ...target });

    expect(matches.map((match) => match.issueId)).toEqual([issueId]);
    expect(matches[0]?.matchedBy).toEqual(["notes"]);
  });

  it("finds a scheduled monitor by a pull_request work product", async () => {
    const company = await seedCompany();
    const issueId = await seedIssue(company, { monitor: {} });
    await db.insert(issueWorkProducts).values({
      companyId: company.companyId,
      issueId,
      type: "pull_request",
      provider: "github",
      externalId: "12",
      title: "Fix the thing",
      url: "https://github.com/Open/Repo/pull/12",
      status: "active",
    });

    const matches = await findIssuesWithMonitorForPullRequest(db, { companyId: company.companyId, ...target });

    expect(matches.map((match) => match.issueId)).toEqual([issueId]);
    expect(matches[0]?.matchedBy).toEqual(["workProduct"]);
  });

  it("ignores work products that are not pull requests", async () => {
    const company = await seedCompany();
    const issueId = await seedIssue(company, { monitor: {} });
    await db.insert(issueWorkProducts).values({
      companyId: company.companyId,
      issueId,
      type: "branch",
      provider: "github",
      title: "Branch",
      url: "https://github.com/open/repo/pull/12",
      status: "active",
    });

    expect(await findIssuesWithMonitorForPullRequest(db, { companyId: company.companyId, ...target })).toEqual([]);
  });

  it("does not match a different pull request or an /issues/N reference", async () => {
    const company = await seedCompany();
    await seedIssue(company, { monitor: { externalRef: "https://github.com/open/repo/issues/12" } });
    await seedIssue(company, { monitor: { externalRef: "open/repo#13" } });
    await seedIssue(company, { monitor: { externalRef: "open/other#12" } });

    expect(await findIssuesWithMonitorForPullRequest(db, { companyId: company.companyId, ...target })).toEqual([]);
  });

  it("ignores an unscheduled monitor", async () => {
    const company = await seedCompany();
    await seedIssue(company, { monitor: { externalRef: "open/repo#12" }, scheduled: false });

    expect(await findIssuesWithMonitorForPullRequest(db, { companyId: company.companyId, ...target })).toEqual([]);
  });

  it("applies the triggerIssueMonitor gate to status and assignee", async () => {
    const company = await seedCompany();
    await seedIssue(company, { monitor: { externalRef: "open/repo#12" }, status: "blocked" });
    await seedIssue(company, { monitor: { externalRef: "open/repo#12" }, status: "todo" });
    await seedIssue(company, { monitor: { externalRef: "open/repo#12" }, assigneeUserId: "some-user" });
    const inReview = await seedIssue(company, { monitor: { externalRef: "open/repo#12" }, status: "in_review" });

    const matches = await findIssuesWithMonitorForPullRequest(db, { companyId: company.companyId, ...target });

    expect(matches.map((match) => match.issueId)).toEqual([inReview]);
  });

  it("ignores another company's issue", async () => {
    const mine = await seedCompany();
    const other = await seedCompany();
    await seedIssue(other, { monitor: { externalRef: "open/repo#12" } });
    const own = await seedIssue(mine, { monitor: { externalRef: "open/repo#12" } });

    const matches = await findIssuesWithMonitorForPullRequest(db, { companyId: mine.companyId, ...target });

    expect(matches.map((match) => match.issueId)).toEqual([own]);
  });

  it("reports every way one issue matches and several issues for one pull request", async () => {
    const company = await seedCompany();
    const first = await seedIssue(company, { monitor: { externalRef: "open/repo#12" }, notes: "see open/repo#12" });
    const second = await seedIssue(company, { monitor: { externalRef: "https://github.com/open/repo/pull/12/files" } });

    const matches = await findIssuesWithMonitorForPullRequest(db, { companyId: company.companyId, ...target });

    expect(matches.map((match) => match.issueId).sort()).toEqual([first, second].sort());
    expect(matches.find((match) => match.issueId === first)?.matchedBy).toEqual(["pullRequests", "notes"]);
  });
});
