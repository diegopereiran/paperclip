import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issueLabels,
  issues,
  labels,
  projects,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { costService } from "../services/costs.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

function createApp(db: Db, companyId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "board-user", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true };
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

// October 2026 in Pacific/Auckland: [2026-09-30T11:00Z, 2026-10-31T11:00Z).
const FROM = "2026-09-30T11:00:00Z";
const TO = "2026-10-31T11:00:00Z";
const d = (iso: string) => new Date(iso);

describeEmbeddedPostgres("run window outcome and class aggregates", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-window-outcomes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(issueLabels);
    await db.delete(labels);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  async function seed() {
    const nonce = randomUUID().slice(0, 6).toUpperCase();
    const [company] = await db.insert(companies).values({ name: `Outcome Co ${nonce}`, issuePrefix: `O${nonce}` }).returning();
    const companyId = company!.id;
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name: "Costed", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {} })
      .returning();
    const agentId = agent!.id;
    const [projX] = await db.insert(projects).values({ companyId, name: "Project X" }).returning();
    const [projY] = await db.insert(projects).values({ companyId, name: "Project Y" }).returning();
    const lab = async (name: string) => {
      const [row] = await db.insert(labels).values({ companyId, name, color: "#000000" }).returning();
      return row!.id;
    };
    const L = {
      p1: await lab("P1"), p2: await lab("P2"), p3: await lab("P3"), enh: await lab("enhancement"),
      xs: await lab("size: XS"), s: await lab("size: S"), l: await lab("size: L"), other: await lab("unrelated"),
    };
    let n = 0;
    const mkIssue = async (v: { projectId?: string; labelIds?: string[]; acceptedAt?: Date }) => {
      n += 1;
      const [row] = await db
        .insert(issues)
        .values({
          companyId, identifier: `O${nonce}-${n}`, title: `Issue ${n}`, status: "todo", priority: "medium",
          projectId: v.projectId ?? null, acceptedOutcomeAt: v.acceptedAt ?? null,
        })
        .returning();
      for (const labelId of v.labelIds ?? []) await db.insert(issueLabels).values({ issueId: row!.id, labelId, companyId });
      return row!.id;
    };
    // A: two P labels and two size labels -> P2 (most severe), size L (largest), enhancement.
    const A = await mkIssue({ projectId: projX!.id, labelIds: [L.p3, L.p2, L.enh, L.s, L.l, L.other], acceptedAt: d("2026-10-10T00:00:00Z") });
    const B = await mkIssue({ labelIds: [L.enh], acceptedAt: d(TO) }); // accepted exactly at the exclusive end
    const C = await mkIssue({ projectId: projY!.id, acceptedAt: d("2026-09-30T10:59:59Z") }); // no labels, accepted before the window
    const D = await mkIssue({ labelIds: [L.p1, L.xs], acceptedAt: d("2026-10-20T00:00:00Z") });
    const E = await mkIssue({ labelIds: [L.other] }); // labelled, but no class label

    const mkRun = async (createdAt: string, issueId?: string) => {
      const [run] = await db
        .insert(heartbeatRuns)
        .values({ companyId, agentId, status: "succeeded", createdAt: d(createdAt), contextSnapshot: issueId ? { issueId } : {} })
        .returning();
      return run!.id;
    };
    const r1 = await mkRun("2026-10-02T00:00:00Z", A);
    const r2 = await mkRun("2026-10-03T00:00:00Z", A);
    const r3 = await mkRun("2026-10-04T00:00:00Z", B);
    const r4 = await mkRun("2026-10-05T00:00:00Z", C);
    const r5 = await mkRun("2026-10-06T00:00:00Z");
    const r6 = await mkRun("2026-10-07T00:00:00Z", D);
    const r7 = await mkRun("2026-10-08T00:00:00Z", E);
    // r1 touches issues of one project; r2 touches issues of two projects.
    const touch = (runId: string, issueId: string) =>
      db.insert(activityLog).values({ companyId, actorType: "agent", actorId: agentId, action: "issue.updated", entityType: "issue", entityId: issueId, agentId, runId });
    await touch(r1, A);
    await touch(r2, A);
    await touch(r2, C);

    // Tokens scale with cents so each event is identifiable: input = cents, cache read = 2 * cents, output = 3 * cents.
    const cost = (v: { cents: number; at: string; runId?: string; issueId?: string; projectId?: string }) =>
      db.insert(costEvents).values({
        companyId, agentId, provider: "p", model: "m", costCents: v.cents, occurredAt: d(v.at),
        inputTokens: v.cents, cachedInputTokens: 2 * v.cents, outputTokens: 3 * v.cents,
        heartbeatRunId: v.runId ?? null, issueId: v.issueId ?? null, projectId: v.projectId ?? null,
      });
    await cost({ cents: 100, at: "2026-10-06T01:00:00Z", runId: r5, projectId: projY!.id }); // event project wins; no issue
    await cost({ cents: 200, at: "2026-10-02T01:00:00Z", runId: r1 }); // single-project run -> X; class via run issue A
    await cost({ cents: 400, at: "2026-10-03T01:00:00Z", runId: r2 }); // two-project run -> Unattributed; class A
    await cost({ cents: 800, at: "2026-10-09T01:00:00Z" }); // no run, no issue
    await cost({ cents: 3200, at: "2026-10-07T01:00:00Z", runId: r6, issueId: D }); // explicit issue D
    await cost({ cents: 1600, at: TO, runId: r1 }); // exactly at the exclusive end: outside
    await cost({ cents: 6400, at: "2026-09-30T10:59:59Z", runId: r1 }); // before the window
    await cost({ cents: 12800, at: "2026-10-08T01:00:00Z", runId: r7 }); // issue with no class label
    return { companyId, projX: projX!.id, projY: projY!.id, A, B, C, D, E, r1, r2, r3, r4, r5, r6, r7 };
  }

  const get = (companyId: string) => request(createApp(db, companyId)).get(`/api/companies/${companyId}/runs/window?month=2026-10`);

  it("reconciles class rows plus unclassified to each window total", async () => {
    const s = await seed();
    const res = await get(s.companyId);
    expect(res.status).toBe(200);
    expect(res.body.window.from).toBe("2026-09-30T11:00:00.000Z");
    const o = res.body.outcomes;

    expect(res.body.aggregates.runCount).toBe(7);
    expect(o.acceptedOutcomeCount).toBe(2); // A and D; B is at the exclusive end, C is before the window
    expect(o.costCents).toBe(100 + 200 + 400 + 800 + 3200 + 12800);
    expect(o.costCentsPerAcceptedOutcome).toBe(o.costCents / 2);

    // Step-1 exclusive attribution: event project, else single-project run, else null (Unattributed).
    const byProject = new Map<string | null, number>(o.costByProject.map((p: { projectId: string | null; costCents: number }) => [p.projectId, p.costCents]));
    expect(byProject.get(s.projY)).toBe(100);
    expect(byProject.get(s.projX)).toBe(200);
    expect(byProject.get(null)).toBe(400 + 800 + 3200 + 12800);
    expect(o.costByProject.reduce((a: number, p: { costCents: number }) => a + p.costCents, 0)).toBe(o.costCents);

    const rows = o.classes.rows as Array<{ priority: string | null; enhancement: boolean; size: string | null; runCount: number; costCents: number; acceptedOutcomeCount: number }>;
    expect(rows).toContainEqual(expect.objectContaining({ priority: "P2", enhancement: true, size: "L", runCount: 2, costCents: 600, acceptedOutcomeCount: 1 }));
    expect(rows).toContainEqual(expect.objectContaining({ priority: "P1", enhancement: false, size: "XS", runCount: 1, costCents: 3200, acceptedOutcomeCount: 1 }));
    expect(rows).toContainEqual(expect.objectContaining({ priority: null, enhancement: true, size: null, runCount: 1, costCents: 0, acceptedOutcomeCount: 0 }));
    expect(rows).toHaveLength(3);
    expect(rows.some((r) => r.priority === null && !r.enhancement && r.size === null)).toBe(false);
    // r4 (no labels), r5 (no issue), r7 (label without class meaning).
    expect(o.classes.unclassified).toMatchObject({ runCount: 3, costCents: 100 + 800 + 12800, acceptedOutcomeCount: 0 });

    const sum = (k: "runCount" | "costCents" | "acceptedOutcomeCount") => rows.reduce((a, r) => a + r[k], 0) + o.classes.unclassified[k];
    expect(sum("runCount")).toBe(res.body.aggregates.runCount);
    expect(sum("costCents")).toBe(o.costCents);
    expect(sum("acceptedOutcomeCount")).toBe(o.acceptedOutcomeCount);
  });

  it("reports a null cost per accepted outcome when nothing was accepted", async () => {
    const s = await seed();
    await db.update(issues).set({ acceptedOutcomeAt: null }).where(eq(issues.companyId, s.companyId));
    const res = await get(s.companyId);
    expect(res.status).toBe(200);
    expect(res.body.outcomes.acceptedOutcomeCount).toBe(0);
    expect(res.body.outcomes.costCentsPerAcceptedOutcome).toBeNull();
    expect(res.body.outcomes.costCents).toBe(17500);
  });

  it("returns an empty, reconciled block for a window with no data", async () => {
    const s = await seed();
    const res = await request(createApp(db, s.companyId)).get(`/api/companies/${s.companyId}/runs/window?month=2025-01`);
    expect(res.status).toBe(200);
    expect(res.body.outcomes).toMatchObject({
      acceptedOutcomeCount: 0, costCents: 0, costCentsPerAcceptedOutcome: null, costByProject: [],
      classes: { rows: [], unclassified: { runCount: 0, costCents: 0, acceptedOutcomeCount: 0, tokensPerAcceptedOutcome: null } },
      tokens: { input: 0, cacheRead: 0, cacheWrite: null, output: 0, total: 0 },
      tokensPerAcceptedOutcome: null,
    });
  });

  type Tokens = { input: number; cacheRead: number; cacheWrite: null; output: number; total: number };
  type Counts = { runCount: number; costCents: number; acceptedOutcomeCount: number; tokens: Tokens; tokensPerAcceptedOutcome: number | null };
  const tokensFor = (cents: number) => ({ input: cents, cacheRead: 2 * cents, cacheWrite: null, output: 3 * cents, total: 6 * cents });

  it("splits tokens by class and reconciles them to the window total and the cost ledger", async () => {
    const s = await seed();
    const res = await get(s.companyId);
    const o = res.body.outcomes;
    const rows = o.classes.rows as Array<Counts & { priority: string | null }>;
    const all: Counts[] = [...rows, o.classes.unclassified];

    expect(o.tokens).toEqual(tokensFor(o.costCents));
    expect(o.tokensPerAcceptedOutcome).toBe(o.tokens.total / 2);
    expect(o.acceptedOutcomeDefinition).toContain("accepted_outcome_at");
    expect(o.acceptedOutcomeDefinition).toContain("reopen or cancel");
    expect(rows.find((r) => r.priority === "P2")!.tokens).toEqual(tokensFor(600));
    expect(rows.find((r) => r.priority === "P2")!.tokensPerAcceptedOutcome).toBe(6 * 600);
    expect(o.classes.unclassified.tokens).toEqual(tokensFor(100 + 800 + 12800));
    expect(o.classes.unclassified.tokensPerAcceptedOutcome).toBeNull();
    for (const c of all) expect(c.tokens.total).toBe(c.tokens.input + c.tokens.cacheRead + c.tokens.output);
    for (const k of ["input", "cacheRead", "output", "total"] as const) {
      expect(all.reduce((a, c) => a + c.tokens[k], 0)).toBe(o.tokens[k]);
    }

    // The window token total equals the cost ledger's own totals for the same range.
    const ledger = await costService(db).byProvider(s.companyId, { from: d(FROM), to: new Date(d(TO).getTime() - 1) });
    expect(ledger.reduce((a, r) => a + Number(r.inputTokens), 0)).toBe(o.tokens.input);
    expect(ledger.reduce((a, r) => a + Number(r.cachedInputTokens), 0)).toBe(o.tokens.cacheRead);
    expect(ledger.reduce((a, r) => a + Number(r.outputTokens), 0)).toBe(o.tokens.output);
  });

  it("uses the ledger's exclusive input for pre-receipt openai events", async () => {
    const s = await seed();
    await db.insert(costEvents).values({
      companyId: s.companyId, agentId: (await db.select().from(agents).where(eq(agents.companyId, s.companyId)))[0]!.id,
      provider: "openai", model: "gpt-x", costCents: 0, occurredAt: d("2026-10-12T00:00:00Z"),
      inputTokens: 1000, cachedInputTokens: 400, outputTokens: 50,
    });
    const o = (await get(s.companyId)).body.outcomes;
    expect(o.tokens.input).toBe(17500 + 600);
    expect(o.tokens.cacheRead).toBe(2 * 17500 + 400);
  });

  it("reports null per-outcome tokens and no NaN in a month with no accepted outcomes", async () => {
    const s = await seed();
    await db.update(issues).set({ acceptedOutcomeAt: null }).where(eq(issues.companyId, s.companyId));
    const res = await get(s.companyId);
    expect(res.body.outcomes.tokensPerAcceptedOutcome).toBeNull();
    for (const c of [...res.body.outcomes.classes.rows, res.body.outcomes.classes.unclassified]) expect(c.tokensPerAcceptedOutcome).toBeNull();
    expect(res.text).not.toMatch(/NaN|Infinity/);
    const sub = await request(createApp(db, s.companyId)).get(`/api/companies/${s.companyId}/runs/window/outcomes?month=2026-10`);
    expect(sub.status).toBe(200);
    expect(sub.body).toMatchObject({ acceptedOutcomeCount: 0, rows: [], nextCursor: null });
  });

  it("lists accepted outcomes once per issue, paged, matching the count and the class rows", async () => {
    const s = await seed();
    // More accepted issues, two sharing one timestamp so the keyset must tie-break on id; one NZ-just-outside.
    const same = d("2026-10-15T12:00:00Z");
    const extra: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const [row] = await db.insert(issues).values({
        companyId: s.companyId, identifier: `X-${i}-${randomUUID().slice(0, 4)}`, title: `Extra ${i}`, status: i === 0 ? "cancelled" : "done", priority: "medium",
        acceptedOutcomeAt: i < 3 ? same : d("2026-10-31T11:00:00Z"), acceptedOutcomeRef: i === 1 ? "pr#7" : null,
      }).returning();
      extra.push(row!.id);
    }
    await db.execute(sql`UPDATE issues SET accepted_outcome_at = accepted_outcome_at + (random() * 999)::int * interval '1 microsecond' WHERE id IN (${sql.join(extra.slice(0, 3).map((id) => sql`${id}::uuid`), sql`, `)})`);
    const app = createApp(db, s.companyId);
    const url = (cursor: string | null) => `/api/companies/${s.companyId}/runs/window/outcomes?month=2026-10&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const rows: Array<{ issueId: string; identifier: string; acceptedOutcomeAt: string; acceptedOutcomeRef: string | null; status: string; class: unknown }> = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await request(app).get(url(cursor));
      expect(res.status).toBe(200);
      expect(res.body.acceptedOutcomeCount).toBe(5);
      expect(res.body.window.from).toBe(FROM.replace("Z", ".000Z"));
      rows.push(...res.body.rows);
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);

    const ids = rows.map((r) => r.issueId);
    expect(new Set(ids).size).toBe(ids.length);
    const main = (await get(s.companyId)).body.outcomes;
    expect(rows).toHaveLength(main.acceptedOutcomeCount);
    expect(ids).toContain(s.A);
    expect(ids).toContain(s.D);
    expect(ids).not.toContain(s.B); // exactly at the exclusive end
    expect(ids).not.toContain(s.C); // one second before the window
    expect(ids).not.toContain(extra[3]); // 2026-11-01 00:00 NZDT
    expect(rows.map((r) => r.acceptedOutcomeAt)).toEqual([...rows.map((r) => r.acceptedOutcomeAt)].sort());
    expect(rows.find((r) => r.issueId === s.A)).toMatchObject({ status: "todo", acceptedOutcomeRef: null, class: { priority: "P2", enhancement: true, size: "L" } });
    expect(rows.find((r) => r.issueId === s.D)!.class).toEqual({ priority: "P1", enhancement: false, size: "XS" });
    expect(rows.find((r) => r.issueId === extra[0])).toMatchObject({ status: "cancelled", class: null }); // cancel keeps the marker
    expect(rows.find((r) => r.issueId === extra[1])!.acceptedOutcomeRef).toBe("pr#7");

    // Per-class counts of the sub-resource equal the classes table.
    const unclassifiedRows = rows.filter((r) => r.class === null).length;
    expect(unclassifiedRows).toBe(main.classes.unclassified.acceptedOutcomeCount);
    expect(main.classes.rows.reduce((a: number, r: Counts) => a + r.acceptedOutcomeCount, 0) + main.classes.unclassified.acceptedOutcomeCount).toBe(rows.length);
  });

  it("validates sub-resource input like runs/window, scopes to the company and leaks no run content", async () => {
    const s = await seed();
    const other = await seed();
    const app = createApp(db, s.companyId);
    for (const bad of ["", "month=2026-13", "month=2026-10&limit=0", "month=2026-10&cursor=junk", "month=2026-10&tz=Not/AZone"]) {
      expect((await request(app).get(`/api/companies/${s.companyId}/runs/window/outcomes?${bad}`)).status, bad).toBe(400);
    }
    const res = await request(app).get(`/api/companies/${s.companyId}/runs/window/outcomes?month=2026-10`);
    expect(res.body.rows.map((r: { issueId: string }) => r.issueId)).not.toContain(other.A);
    expect(Object.keys(res.body.rows[0]).sort()).toEqual(["acceptedOutcomeAt", "acceptedOutcomeRef", "class", "identifier", "issueId", "status"]);
    expect(Object.keys(res.body).sort()).toEqual(["acceptedOutcomeCount", "acceptedOutcomeDefinition", "nextCursor", "rows", "window"]);
  });
});
