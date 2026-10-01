import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";
import { createPullRequestMonitorPoller } from "../services/issue-monitor-pull-request-poller.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres PR monitor poller tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const TOKEN = "ghp_super_secret_token_value";
const MINUTE = 60_000;
const T0 = new Date("2026-10-01T12:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * MINUTE);

interface FakePullRequest {
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  mergeableState: string;
  suites: Array<{ status: string; conclusion: string | null }>;
  comments: number[];
  reviews: number[];
}

function freshPullRequest(): FakePullRequest {
  return {
    state: "open",
    merged: false,
    headSha: "sha-1",
    mergeableState: "clean",
    suites: [{ status: "completed", conclusion: "success" }],
    comments: [],
    reviews: [],
  };
}

function createFakeGitHub() {
  const pulls = new Map<string, FakePullRequest>();
  const requests: Array<{ url: string; ifNoneMatch: string | null; authorization: string | null }> = [];
  let failWith: { status: number; headers?: Record<string, string> } | null = null;

  function respond(request: Request | { url: string }, init: RequestInit | undefined) {
    const url = typeof request === "string" ? request : (request as { url: string }).url;
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    requests.push({
      url,
      ifNoneMatch: headers.get("if-none-match"),
      authorization: headers.get("authorization"),
    });
    if (failWith) return new Response("{}", { status: failWith.status, headers: failWith.headers });
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/(pulls|issues|commits)\/([^/]+)(?:\/(.+))?$/);
    if (!match) return new Response("{}", { status: 404 });
    const [, owner, repo, kind, id, rest] = match;
    const key = `${owner}/${repo}`;
    const entry = [...pulls.entries()].find(([ref]) => ref.startsWith(`${key}#`) && (kind === "commits" ? pulls.get(ref)?.headSha === id : ref === `${key}#${id}`));
    if (!entry) return new Response("{}", { status: 404 });
    const pr = entry[1];
    let body: unknown;
    if (kind === "pulls" && !rest) {
      body = { state: pr.state, merged: pr.merged, mergeable_state: pr.mergeableState, head: { sha: pr.headSha } };
    } else if (kind === "pulls" && rest === "reviews") {
      body = pr.reviews.map((reviewId) => ({ id: reviewId }));
    } else if (kind === "issues" && rest === "comments") {
      body = pr.comments.map((commentId) => ({ id: commentId }));
    } else if (kind === "commits" && rest?.startsWith("check-suites")) {
      body = { total_count: pr.suites.length, check_suites: pr.suites };
    } else {
      return new Response("{}", { status: 404 });
    }
    const text = JSON.stringify(body);
    const etag = `"${createHash("sha1").update(text).digest("hex")}"`;
    if (headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
    return new Response(text, { status: 200, headers: { etag, "content-type": "application/json" } });
  }

  return {
    requests,
    set(ref: string, pr: FakePullRequest = freshPullRequest()) {
      pulls.set(ref, pr);
      return pr;
    },
    fail(response: { status: number; headers?: Record<string, string> } | null) {
      failWith = response;
    },
    fetch: vi.fn(async (url: string, init?: RequestInit) => respond({ url }, init)),
  };
}

function loggedText(log: ReturnType<typeof createLog>) {
  return JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.debug.mock.calls, log.error.mock.calls]);
}

function createLog() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
}

describeEmbeddedPostgres("pull request monitor poller", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pr-monitor-poller-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  let issueCounter = 0;

  async function seedCompany(status = "active") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Poller Co",
      issuePrefix,
      status,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Poller Bot",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId, issuePrefix };
  }

  async function seedMonitor(
    company: { companyId: string; agentId: string; issuePrefix: string },
    prUrl = "https://github.com/open/repo/pull/12",
  ) {
    const id = randomUUID();
    issueCounter += 1;
    const nextCheckAt = "2026-12-01T12:00:00.000Z";
    const policy = normalizeIssueExecutionPolicy(
      { monitor: { nextCheckAt, externalRef: prUrl, notes: "waiting" } },
      { source: "client" },
    );
    await db.insert(issues).values({
      id,
      companyId: company.companyId,
      title: "Watch a PR",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: company.agentId,
      issueNumber: issueCounter,
      identifier: `${company.issuePrefix}-${issueCounter}`,
      executionPolicy: policy as unknown as Record<string, unknown>,
      monitorNextCheckAt: new Date(nextCheckAt),
      monitorNotes: "waiting",
      monitorScheduledBy: "assignee",
    });
    return id;
  }

  async function storedState(issueId: string) {
    const [row] = await db.select({ executionPolicy: issues.executionPolicy }).from(issues).where(eq(issues.id, issueId));
    return (row?.executionPolicy as { monitor?: { pullRequestState?: Record<string, unknown> } } | null)?.monitor
      ?.pullRequestState;
  }

  function setup(options: { getToken?: (companyId: string) => Promise<string | null> } = {}) {
    const github = createFakeGitHub();
    github.set("open/repo#12");
    const triggerMonitor = vi.fn(async () => ({ outcome: "triggered" as const }));
    const log = createLog();
    const getToken = options.getToken ?? (async () => TOKEN);
    const poller = createPullRequestMonitorPoller(db, {
      fetch: github.fetch,
      getToken,
      triggerMonitor,
      log,
    });
    return { github, triggerMonitor, log, poller, getToken };
  }

  it("records a baseline on first sight and does not wake", async () => {
    const company = await seedCompany();
    const issueId = await seedMonitor(company);
    const { poller, triggerMonitor, github } = setup();

    const result = await poller.poll(T0);

    expect(triggerMonitor).not.toHaveBeenCalled();
    expect(result).toMatchObject({ polled: 1, baselined: 1, woken: 0 });
    expect(github.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/repos/open/repo/pulls/12",
      "/repos/open/repo/commits/sha-1/check-suites",
      "/repos/open/repo/issues/12/comments",
      "/repos/open/repo/pulls/12/reviews",
    ]);
    expect(github.requests.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(await storedState(issueId)).toEqual({
      "open/repo#12": {
        headSha: "sha-1",
        checkConclusion: "success",
        latestCommentId: null,
        latestReviewId: null,
        state: "open",
        mergeableState: "clean",
      },
    });
  });

  it("does not request again before the poll interval has passed", async () => {
    const company = await seedCompany();
    await seedMonitor(company);
    const { poller, github } = setup();

    await poller.poll(T0);
    const before = github.requests.length;
    await poller.poll(at(1));

    expect(github.requests.length).toBe(before);
  });

  it.each([
    ["head sha", (pr: FakePullRequest) => { pr.headSha = "sha-2"; }, "head_sha"],
    ["check conclusion", (pr: FakePullRequest) => { pr.suites = [{ status: "completed", conclusion: "failure" }]; }, "check_conclusion"],
    ["latest comment", (pr: FakePullRequest) => { pr.comments = [301]; }, "comment"],
    ["latest review", (pr: FakePullRequest) => { pr.reviews = [401]; }, "review"],
    ["state", (pr: FakePullRequest) => { pr.state = "closed"; pr.merged = true; }, "state"],
    ["mergeable state", (pr: FakePullRequest) => { pr.mergeableState = "dirty"; }, "mergeable_state"],
  ])("wakes once when the %s changes", async (_label, mutate, field) => {
    const company = await seedCompany();
    const issueId = await seedMonitor(company);
    const { poller, triggerMonitor, github } = setup();
    await poller.poll(T0);

    mutate(github.set("open/repo#12", { ...freshPullRequest() }));
    const result = await poller.poll(at(4));

    expect(result.woken).toBe(1);
    expect(triggerMonitor).toHaveBeenCalledTimes(1);
    expect(triggerMonitor).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({
        trigger: expect.objectContaining({
          source: "github",
          event: expect.stringContaining(field),
          repo: "open/repo",
          number: 12,
        }),
      }),
    );
  });

  it("costs one request set for two monitors on one PR and wakes both", async () => {
    const company = await seedCompany();
    const first = await seedMonitor(company, "https://github.com/open/repo/pull/12");
    const second = await seedMonitor(company, "Open/Repo#12");
    const { poller, triggerMonitor, github } = setup();

    await poller.poll(T0);
    expect(github.requests).toHaveLength(4);
    expect(await storedState(first)).toBeDefined();
    expect(await storedState(second)).toBeDefined();

    github.requests.length = 0;
    github.set("open/repo#12", { ...freshPullRequest(), headSha: "sha-2" });
    await poller.poll(at(4));

    expect(github.requests).toHaveLength(4);
    expect(triggerMonitor.mock.calls.map((call) => call[0]).sort()).toEqual([first, second].sort());
  });

  it("sends If-None-Match and treats 304 responses as no change", async () => {
    const company = await seedCompany();
    await seedMonitor(company);
    const { poller, triggerMonitor, github } = setup();
    await poller.poll(T0);

    github.requests.length = 0;
    const result = await poller.poll(at(4));

    expect(github.requests).toHaveLength(4);
    expect(github.requests.every((request) => request.ifNoneMatch !== null)).toBe(true);
    expect(triggerMonitor).not.toHaveBeenCalled();
    expect(result.woken).toBe(0);
  });

  it("does not take an unknown mergeable state as a change", async () => {
    const company = await seedCompany();
    const issueId = await seedMonitor(company);
    const { poller, triggerMonitor, github } = setup();
    github.set("open/repo#12", { ...freshPullRequest(), mergeableState: "unknown" });
    await poller.poll(T0);

    github.set("open/repo#12", { ...freshPullRequest(), mergeableState: "clean" });
    await poller.poll(at(4));

    expect(triggerMonitor).not.toHaveBeenCalled();
    expect((await storedState(issueId))?.["open/repo#12"]).toMatchObject({ mergeableState: "clean" });
  });

  it("pauses a company until retry-after passes and leaves other companies polling", async () => {
    const limited = await seedCompany();
    const healthy = await seedCompany();
    await seedMonitor(limited, "https://github.com/limited/repo/pull/1");
    await seedMonitor(healthy, "https://github.com/healthy/repo/pull/2");
    const tokens = new Map([[limited.companyId, "limited-token"], [healthy.companyId, "healthy-token"]]);
    const { poller, github, triggerMonitor, log } = setup({ getToken: async (id) => tokens.get(id) ?? null });
    github.set("limited/repo#1");
    github.set("healthy/repo#2");
    const originalFetch = github.fetch.getMockImplementation()!;
    github.fetch.mockImplementation(async (url, init) => {
      const headers = new Headers(init?.headers as HeadersInit);
      if (headers.get("authorization") === "Bearer limited-token") {
        github.requests.push({ url, ifNoneMatch: null, authorization: "limited" });
        return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "retry-after": "600" } });
      }
      return originalFetch(url, init);
    });

    await poller.poll(T0);
    const limitedCallsAfterFirst = github.requests.filter((request) => request.authorization === "limited").length;
    expect(limitedCallsAfterFirst).toBe(1);

    await poller.poll(at(8));
    expect(github.requests.filter((request) => request.authorization === "limited")).toHaveLength(1);
    expect(github.requests.some((request) => request.url.includes("/healthy/repo/"))).toBe(true);

    await poller.poll(at(11));
    expect(github.requests.filter((request) => request.authorization === "limited")).toHaveLength(2);
    expect(triggerMonitor).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(loggedText(log)).not.toContain("limited-token");
  });

  it("skips a company with no GitHub token with one log line", async () => {
    const company = await seedCompany();
    await seedMonitor(company);
    const { poller, github, triggerMonitor, log } = setup({ getToken: async () => null });

    await poller.poll(T0);
    await poller.poll(at(4));
    await poller.poll(at(8));

    expect(github.fetch).not.toHaveBeenCalled();
    expect(triggerMonitor).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("polls a company created after the poller started once it has a token", async () => {
    const { poller, github } = setup();
    await poller.poll(T0);
    expect(github.fetch).not.toHaveBeenCalled();

    const lateCompany = await seedCompany();
    const issueId = await seedMonitor(lateCompany);
    await poller.poll(at(1));

    expect(github.fetch).toHaveBeenCalled();
    expect(await storedState(issueId)).toBeDefined();
  });

  it("does not poll a company that is not active", async () => {
    const company = await seedCompany("paused");
    await seedMonitor(company);
    const { poller, github } = setup();

    await poller.poll(T0);

    expect(github.fetch).not.toHaveBeenCalled();
  });

  it("never writes the token to a log line", async () => {
    const company = await seedCompany();
    await seedMonitor(company);
    const { poller, github, log } = setup();
    github.fail({ status: 401 });

    await poller.poll(T0);
    github.fail({ status: 500 });
    await poller.poll(at(10));

    expect(log.warn).toHaveBeenCalled();
    expect(loggedText(log)).not.toContain(TOKEN);
  });

  it("does not wake when the pull request is missing or the server fails", async () => {
    const company = await seedCompany();
    const issueId = await seedMonitor(company, "https://github.com/open/repo/pull/99");
    const { poller, triggerMonitor } = setup();

    const result = await poller.poll(T0);

    expect(result.woken).toBe(0);
    expect(triggerMonitor).not.toHaveBeenCalled();
    expect(await storedState(issueId)).toBeUndefined();
  });
  it("does not wake after a restart when an older comment is no longer in the since window", async () => {
    const company = await seedCompany();
    await seedMonitor(company);
    const { poller, triggerMonitor, github, getToken } = setup();
    await poller.poll(T0);

    github.set("open/repo#12", { ...freshPullRequest(), comments: [301] });
    const late = await seedMonitor(company);
    await poller.poll(at(4));
    expect(triggerMonitor).toHaveBeenCalledTimes(1);
    expect((await storedState(late))?.["open/repo#12"]).toMatchObject({ latestCommentId: 301 });

    github.set("open/repo#12", { ...freshPullRequest(), comments: [] });
    const restarted = createPullRequestMonitorPoller(db, {
      fetch: github.fetch,
      getToken,
      triggerMonitor,
      log: createLog(),
    });
    await restarted.poll(at(10));

    expect(triggerMonitor).toHaveBeenCalledTimes(1);
  });

  it("does not start a second request set while an earlier poll is still running", async () => {
    const company = await seedCompany();
    await seedMonitor(company);
    const { poller, github } = setup();
    const original = github.fetch.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    github.fetch.mockImplementation(async (url, init) => {
      await gate;
      return original(url, init);
    });

    const first = poller.poll(T0);
    await vi.waitFor(() => expect(github.fetch).toHaveBeenCalledTimes(1));
    const overlapping = await poller.poll(at(4));
    expect(overlapping).toEqual({ polled: 0, baselined: 0, woken: 0 });
    expect(github.fetch).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(github.fetch).toHaveBeenCalledTimes(4);
  });

  it("gives every request a timeout signal", async () => {
    const company = await seedCompany();
    await seedMonitor(company);
    const { poller, github } = setup();

    await poller.poll(T0);

    expect(github.fetch.mock.calls.length).toBeGreaterThan(0);
    expect(github.fetch.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
  });

  it("holds back a rejected wake until the next interval instead of retrying every tick", async () => {
    const company = await seedCompany();
    await seedMonitor(company);
    const { poller, triggerMonitor, github } = setup();
    await poller.poll(T0);
    triggerMonitor.mockRejectedValue(new Error("agent paused"));
    github.set("open/repo#12", { ...freshPullRequest(), headSha: "sha-2" });

    await poller.poll(at(4));
    await poller.poll(at(4.5));
    await poller.poll(at(5));
    expect(triggerMonitor).toHaveBeenCalledTimes(1);

    await poller.poll(at(8));
    expect(triggerMonitor).toHaveBeenCalledTimes(2);
  });
  it("makes no request for a monitor note that names a dot-only owner", async () => {
    const company = await seedCompany();
    await seedMonitor(company, "../orgs#5");
    const { poller, github } = setup();

    await poller.poll(T0);

    expect(github.fetch).not.toHaveBeenCalled();
  });

  it("treats a 403 without a rate limit as a failure of that pull request only", async () => {
    const company = await seedCompany();
    const blocked = await seedMonitor(company, "https://github.com/saml/repo/pull/1");
    const healthy = await seedMonitor(company, "https://github.com/open/repo/pull/12");
    const { poller, github, triggerMonitor } = setup();
    github.set("saml/repo#1");
    const original = github.fetch.getMockImplementation()!;
    github.fetch.mockImplementation(async (url, init) => {
      if (url.includes("/repos/saml/")) return new Response("{}", { status: 403 });
      return original(url, init);
    });
    await poller.poll(T0);
    expect(await storedState(healthy)).toBeDefined();
    expect(await storedState(blocked)).toBeUndefined();

    github.set("open/repo#12", { ...freshPullRequest(), headSha: "sha-2" });
    await poller.poll(at(4));

    expect(triggerMonitor).toHaveBeenCalledTimes(1);
    expect(triggerMonitor).toHaveBeenCalledWith(healthy, expect.anything());
  });

  it("pauses the company on a 401", async () => {
    const company = await seedCompany();
    await seedMonitor(company, "https://github.com/open/repo/pull/12");
    await seedMonitor(company, "https://github.com/open/repo/pull/13");
    const { poller, github } = setup();
    github.fail({ status: 401 });

    await poller.poll(T0);

    expect(github.fetch).toHaveBeenCalledTimes(1);
  });
});
