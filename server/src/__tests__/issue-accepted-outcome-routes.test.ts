import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("issue accepted-outcome fields", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const companyId = randomUUID();
  const issueId = randomUUID();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-accepted-outcome-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Outcome", issuePrefix: "OUT", defaultResponsibleUserId: "board-user" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Ticket", identifier: "OUT-1", issueNumber: 1 });
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  function app() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  it("reads null on an existing issue", async () => {
    const got = await request(app()).get(`/api/issues/${issueId}`);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.body.acceptedOutcomeAt).toBeNull();
    expect(got.body.acceptedOutcomeRef).toBeNull();
  });

  it("sets both fields, reads them back, and clears them with null", async () => {
    const at = "2026-10-15T01:02:03.000Z";
    const ref = "open-astro/AlpacaBridge#123";
    const patched = await request(app()).patch(`/api/issues/${issueId}`).send({ acceptedOutcomeAt: at, acceptedOutcomeRef: ref });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.acceptedOutcomeAt).toBe(at);
    expect(patched.body.acceptedOutcomeRef).toBe(ref);
    const got = await request(app()).get(`/api/issues/${issueId}`);
    expect(got.body.acceptedOutcomeAt).toBe(at);
    expect(got.body.acceptedOutcomeRef).toBe(ref);

    const cleared = await request(app()).patch(`/api/issues/${issueId}`).send({ acceptedOutcomeAt: null, acceptedOutcomeRef: null });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    const after = await request(app()).get(`/api/issues/${issueId}`);
    expect(after.body.acceptedOutcomeAt).toBeNull();
    expect(after.body.acceptedOutcomeRef).toBeNull();
  });

  it("rejects an accepted_outcome_at that is not an ISO date", async () => {
    const bad = await request(app()).patch(`/api/issues/${issueId}`).send({ acceptedOutcomeAt: "yesterday" });
    expect(bad.status).toBe(400);
  });

  it("bounds accepted_outcome_ref: rejects blank and 501 characters, accepts 500", async () => {
    for (const bad of ["   ", "\t\n ", "", "x".repeat(501), ` ${"x".repeat(501)} `]) {
      const res = await request(app()).patch(`/api/issues/${issueId}`).send({ acceptedOutcomeRef: bad });
      expect(res.status, JSON.stringify(bad.slice(0, 20))).toBe(400);
    }
    const ok = await request(app()).patch(`/api/issues/${issueId}`).send({ acceptedOutcomeRef: `  ${"x".repeat(500)}  ` });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.acceptedOutcomeRef).toBe("x".repeat(500));
    await request(app()).patch(`/api/issues/${issueId}`).send({ acceptedOutcomeRef: null });
  });
});
