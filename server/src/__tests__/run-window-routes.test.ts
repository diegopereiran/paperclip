import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type Actor = Express.Request["actor"];

function boardActor(companyIds: string[]): Actor {
  return { type: "board", userId: "board-user", companyIds, source: "local_implicit", isInstanceAdmin: true };
}

function createApp(db: Db, actor: Actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

const at = (iso: string, plusSeconds = 0) => new Date(new Date(iso).getTime() + plusSeconds * 1000);

describeEmbeddedPostgres("run window export route", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-window-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  async function seed() {
    const nonce = randomUUID().slice(0, 6).toUpperCase();
    const [company] = await db
      .insert(companies)
      .values({ name: `Window Co ${nonce}`, issuePrefix: `W${nonce}` })
      .returning();
    const companyId = company!.id;
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name: "Windowed", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {} })
      .returning();
    const agentId = agent!.id;
    const mkIssue = async (n: number, parentId: string | null) => {
      const [row] = await db
        .insert(issues)
        .values({ companyId, identifier: `W${nonce}-${n}`, title: `Issue ${n}`, status: "todo", priority: "medium", parentId })
        .returning();
      return row!.id;
    };
    const rootIssue = await mkIssue(1, null);
    const midIssue = await mkIssue(2, rootIssue);
    const leafIssue = await mkIssue(3, midIssue);

    // 2026-10-01 00:00 Pacific/Auckland (NZDT, UTC+13) is 2026-09-30T11:00:00Z.
    const mkRun = async (v: {
      createdAt: Date;
      status: string;
      startedAfter?: number;
      finishedAfter?: number;
      issueId?: string;
      retryOfRunId?: string;
      continuationAttempt?: number;
      wakeBefore?: number;
    }) => {
      let wakeupRequestId: string | undefined;
      if (v.wakeBefore !== undefined) {
        const [wake] = await db
          .insert(agentWakeupRequests)
          .values({ companyId, agentId, source: "on_demand", requestedAt: at(v.createdAt.toISOString(), -v.wakeBefore) })
          .returning();
        wakeupRequestId = wake!.id;
      }
      const [run] = await db
        .insert(heartbeatRuns)
        .values({
          companyId,
          agentId,
          status: v.status,
          createdAt: v.createdAt,
          startedAt: v.startedAfter === undefined ? null : at(v.createdAt.toISOString(), v.startedAfter),
          finishedAt: v.finishedAfter === undefined ? null : at(v.createdAt.toISOString(), v.finishedAfter),
          retryOfRunId: v.retryOfRunId ?? null,
          continuationAttempt: v.continuationAttempt ?? 0,
          wakeupRequestId: wakeupRequestId ?? null,
          contextSnapshot: v.issueId ? { issueId: v.issueId } : {},
          stdoutExcerpt: "SECRET-STDOUT",
          resultJson: { secret: "SECRET-RESULT" },
        })
        .returning();
      return run!.id;
    };

    // August 31 NZST end (UTC+12): 2026-08-31T12:00Z starts September.
    const aug = await mkRun({ createdAt: at("2026-08-31T11:59:59Z"), status: "succeeded", startedAfter: 0, finishedAfter: 5 });
    const s2 = await mkRun({
      createdAt: at("2026-09-15T00:00:00Z"), status: "succeeded", startedAfter: 0, finishedAfter: 60,
      issueId: leafIssue, wakeBefore: 10,
    });
    const s3 = await mkRun({
      createdAt: at("2026-09-30T10:59:59Z"), status: "timed_out", startedAfter: 1, finishedAfter: 121,
      retryOfRunId: s2, issueId: rootIssue,
    });
    const o1 = await mkRun({
      createdAt: at("2026-09-30T11:00:00Z"), status: "failed", startedAfter: 0, finishedAfter: 30, continuationAttempt: 1,
    });
    const o2 = await mkRun({
      createdAt: at("2026-10-05T00:00:00Z"), status: "succeeded", startedAfter: 0, finishedAfter: 90, continuationAttempt: 2,
    });
    const o3 = await mkRun({ createdAt: at("2026-10-31T10:59:59Z"), status: "queued", issueId: leafIssue });
    // Nov 1 00:00 NZDT = 2026-10-31T11:00Z: excluded from October.
    const nov = await mkRun({ createdAt: at("2026-10-31T11:00:00Z"), status: "succeeded", startedAfter: 0, finishedAfter: 1 });
    return { company, companyId, agentId, rootIssue, midIssue, leafIssue, aug, s2, s3, o1, o2, o3, nov };
  }

  const get = (app: express.Express, companyId: string, query: string) =>
    request(app).get(`/api/companies/${companyId}/runs/window?${query}`);

  it("assigns runs to NZ calendar months and aggregates the whole window", async () => {
    const s = await seed();
    const app = createApp(db, boardActor([s.companyId]));

    const sep = await get(app, s.companyId, "month=2026-09");
    expect(sep.status).toBe(200);
    expect(sep.body.window).toMatchObject({
      tz: "Pacific/Auckland",
      from: "2026-08-31T12:00:00.000Z",
      to: "2026-09-30T11:00:00.000Z",
      windowField: "created_at",
    });
    expect(sep.body.rows.map((r: { runId: string }) => r.runId)).toEqual([s.s2, s.s3]);
    expect(sep.body.aggregates).toMatchObject({
      runCount: 2,
      byStatus: { succeeded: 1, timed_out: 1 },
      timeoutCount: 1,
      retryCount: 1,
      continuationCount: 0,
      childRunCount: 1,
    });
    expect(sep.body.aggregates.durationSeconds.p50).toBeCloseTo(90, 5);
    expect(sep.body.aggregates.durationSeconds.p95).toBeCloseTo(117, 5);
    expect(sep.body.aggregates.wakeToFinishSeconds.p50).toBeCloseTo(95.5, 5);
    expect(sep.body.aggregates.wakeToFinishSeconds.p95).toBeCloseTo(118.45, 5);

    const oct = await get(app, s.companyId, "month=2026-10");
    expect(oct.status).toBe(200);
    expect(oct.body.window.from).toBe("2026-09-30T11:00:00.000Z");
    expect(oct.body.window.to).toBe("2026-10-31T11:00:00.000Z");
    expect(oct.body.rows.map((r: { runId: string }) => r.runId)).toEqual([s.o1, s.o2, s.o3]);
    expect(oct.body.aggregates).toMatchObject({
      runCount: 3,
      byStatus: { failed: 1, succeeded: 1, queued: 1 },
      timeoutCount: 0,
      retryCount: 0,
      continuationCount: 2,
      childRunCount: 1,
    });
    expect(oct.body.aggregates.durationSeconds.p50).toBeCloseTo(60, 5);
    expect(oct.body.aggregates.durationSeconds.p95).toBeCloseTo(87, 5);
    expect(oct.body.aggregates.wakeToFinishSeconds.p50).toBeCloseTo(60, 5);
  });

  it("accepts from/to dates and rejects bad input", async () => {
    const s = await seed();
    const app = createApp(db, boardActor([s.companyId]));
    const res = await get(app, s.companyId, "from=2026-10-01&to=2026-10-02&tz=Pacific/Auckland");
    expect(res.status).toBe(200);
    expect(res.body.window.from).toBe("2026-09-30T11:00:00.000Z");
    expect(res.body.window.to).toBe("2026-10-01T11:00:00.000Z");
    expect(res.body.rows.map((r: { runId: string }) => r.runId)).toEqual([s.o1]);
    for (const bad of ["", "month=2026-13", "from=2026-10-02&to=2026-10-01", "month=2026-10&tz=Not/AZone", "month=2026-10&cursor=junk", "month=2026-10&limit=0"]) {
      expect((await get(app, s.companyId, bad)).status, bad).toBe(400);
    }
  });

  it("returns every run exactly once across pages", async () => {
    const s = await seed();
    const same = at("2026-10-10T00:00:00Z");
    // Many runs share one created_at so the keyset must tie-break on id.
    await db.insert(heartbeatRuns).values(
      Array.from({ length: 25 }, () => ({ companyId: s.companyId, agentId: s.agentId, status: "succeeded", createdAt: same })),
    );
    const app = createApp(db, boardActor([s.companyId]));
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(app, s.companyId, `month=2026-10&limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(res.status).toBe(200);
      expect(res.body.aggregates.runCount).toBe(28);
      ids.push(...res.body.rows.map((r: { runId: string }) => r.runId));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(ids).toHaveLength(28);
    expect(new Set(ids).size).toBe(28);
    expect(ids.slice(0, 2)).toEqual([s.o1, s.o2]);
  });

  it("resolves the root issue through two parent levels and exposes only telemetry fields", async () => {
    const s = await seed();
    const app = createApp(db, boardActor([s.companyId]));
    const res = await get(app, s.companyId, "month=2026-09");
    const row = res.body.rows.find((r: { runId: string }) => r.runId === s.s2);
    expect(row).toEqual({
      runId: s.s2,
      agentId: s.agentId,
      status: "succeeded",
      issueId: s.leafIssue,
      rootIssueId: s.rootIssue,
      retryOfRunId: null,
      continuationAttempt: 0,
      createdAt: "2026-09-15T00:00:00.000Z",
      startedAt: "2026-09-15T00:00:00.000Z",
      finishedAt: "2026-09-15T00:01:00.000Z",
    });
    const retry = res.body.rows.find((r: { runId: string }) => r.runId === s.s3);
    expect(retry.retryOfRunId).toBe(s.s2);
    expect(retry.rootIssueId).toBe(s.rootIssue);
    expect(JSON.stringify(res.body)).not.toContain("SECRET");
  });

  it("terminates on a parent cycle", async () => {
    const s = await seed();
    const { eq } = await import("drizzle-orm");
    await db.update(issues).set({ parentId: s.leafIssue }).where(eq(issues.id, s.rootIssue));
    const app = createApp(db, boardActor([s.companyId]));
    const res = await get(app, s.companyId, "month=2026-09");
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: { runId: string }) => r.runId === s.s2);
    expect(typeof row.rootIssueId).toBe("string");
  });

  it("refuses callers without access to the company", async () => {
    const s = await seed();
    const other = randomUUID();
    // Non-admin board user in another company.
    const app = createApp(db, { type: "board", userId: "mallory", companyIds: [other], source: "session", isInstanceAdmin: false });
    expect((await get(app, s.companyId, "month=2026-09")).status).toBe(403);
    const noMembership = createApp(db, { type: "board", userId: "mallory", companyIds: [s.companyId], source: "session", isInstanceAdmin: false });
    expect((await get(noMembership, s.companyId, "month=2026-09")).status).toBe(403);
  });
});
