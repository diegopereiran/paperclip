import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies, createDb, documents, executionWorkspaces, issueComments, issueDocuments, issueThreadInteractions, issues,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { instanceSettingsService } from "./instance-settings.js";
import {
  DISK_ALERT_ORIGIN_KIND,
  INSTANCE_DISK_REAPER_INTERVAL_MS,
  createDiskAlertCardPoster,
  createDiskReaperReportPoster,
  instanceDiskReaperRunner,
  registerInstanceDiskReaperWork,
} from "./instance-disk-reaper-runner.js";

describe("disk alert card poster", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("disk-alert-card-");
    db = createDb(temporary.connectionString);
  }, 240_000);
  afterAll(async () => { await temporary?.cleanup(); });

  const card = { usedPercent: 91, title: "Disk 91% full on /data", summary: "Disk use passed 85%.", detailsMarkdown: "Top consumers:\n- `/data/backups`: 14.0 GiB" };

  it("posts one human-only card to the board user and does not repeat while it is pending", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Alert co", issuePrefix: `A${companyId.slice(0, 6)}` });
    const post = createDiskAlertCardPoster(db);
    expect(await post(card)).toBe("posted");
    expect(await post(card)).toBe("pending_exists");

    const [standing] = await db.select().from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, DISK_ALERT_ORIGIN_KIND)));
    expect(standing).toBeTruthy();
    const cards = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, standing!.id));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      kind: "request_confirmation", status: "pending", effectiveResolverPolicy: "human_only", addresseeUserId: "local-board",
    });
    expect(cards[0]!.title).toBe(card.title);
  });

  it("posts again once the earlier card is answered, on the same standing issue", async () => {
    const post = createDiskAlertCardPoster(db);
    await db.update(issueThreadInteractions).set({ status: "answered" }).where(eq(issueThreadInteractions.status, "pending"));
    expect(await post(card)).toBe("posted");
    const standing = await db.select().from(issues).where(eq(issues.originKind, DISK_ALERT_ORIGIN_KIND));
    expect(standing.length).toBeGreaterThan(0);
  });

  it("comments each pass on the one standing issue and links a document with the full path list", async () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ path: `/var/tmp/paperclip-run-${i}`, bytes: 1024, reason: "idle" }));
    const empty = { candidates: 0, bytes: 0, freedBytes: 0, failed: 0, entries: [], kept: {} };
    const report = (dryRun: boolean) => ({
      dryRun,
      categories: {
        tmp: { ...empty, candidates: 30, bytes: 30 * 1024, freedBytes: dryRun ? 0 : 30 * 1024, entries, kept: { "owned by a live run": 2 } },
        isolatedAttempts: empty, runLogs: empty, backups: empty,
      },
    });
    const post = createDiskReaperReportPoster(db);
    await post(report(true), new Date("2026-11-19T04:00:00Z"));
    await post(report(false), new Date("2026-11-19T04:00:00Z"));

    const standing = await db.select().from(issues).where(eq(issues.originKind, DISK_ALERT_ORIGIN_KIND));
    expect(standing).toHaveLength(1);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, standing[0]!.id));
    expect(comments).toHaveLength(2);
    const [dry, real] = comments.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(dry!.body).toContain("dry run: nothing was deleted");
    expect(real!.body).toContain("run complete");
    expect(real!.body).toContain("30.0 KiB freed from 30");
    expect(real!.body).toContain("kept 2: owned by a live run");
    // Totals and kept reasons only: the paths stay in the document, so the thread stays small.
    expect(real!.body).not.toContain("paperclip-run-");
    expect(real!.body).toContain("#document-disk-reaper-2026-11-19");
    expect(real!.body.length).toBeLessThan(1000);
    const docs = await db.select({ key: issueDocuments.key, body: documents.latestBody }).from(issueDocuments)
      .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
      .where(eq(issueDocuments.issueId, standing[0]!.id));
    expect(docs.map((d) => d.key)).toEqual(["disk-reaper-2026-11-19"]);
    expect(docs[0]!.body).toContain("paperclip-run-29");
  });
});

describe("isolated attempt ownership", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("disk-reaper-attempts-");
    db = createDb(temporary.connectionString);
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "disk-reaper-attempts-")));
    await instanceSettingsService(db).updateGeneral({ diskReaper: { dryRun: false, diskAlertPercent: 100 } });
  }, 240_000);
  afterAll(async () => {
    await temporary?.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function idleAttempt(companyId: string): Promise<string> {
    // The attempt id is the seeding run id, which no workspace row carries.
    const dir = path.join(root, "instance", "isolated-workspace-attempts", companyId, randomUUID(), randomUUID());
    await fs.mkdir(path.join(dir, "workspace"), { recursive: true });
    await fs.writeFile(path.join(dir, "workspace", "work.txt"), "uncommitted");
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    for (const p of [path.join(dir, "workspace", "work.txt"), path.join(dir, "workspace"), dir]) await fs.utimes(p, old, old);
    return dir;
  }

  it("keeps an attempt whose workspace row is open under a random id, and removes it once the row is archived", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Attempt co", issuePrefix: `T${companyId.slice(0, 6)}` });
    const dir = await idleAttempt(companyId);
    const [row] = await db.insert(executionWorkspaces).values({
      companyId, mode: "isolated_workspace", strategyType: "project_primary", name: "task", status: "active",
      cwd: path.join(dir, "workspace"),
    }).returning();
    const runner = instanceDiskReaperRunner(db, {
      instanceRoot: path.join(root, "instance"),
      backupDir: path.join(root, "backups"),
      tmpRoot: path.join(root, "tmp"),
      runLogRoot: path.join(root, "run-logs"),
    });

    const kept = await runner.run();
    expect(kept.report.categories.isolatedAttempts.candidates).toBe(0);
    expect(kept.report.categories.isolatedAttempts.kept).toEqual({ "owned by a live run or active workspace": 1 });
    expect(await fs.stat(path.join(dir, "workspace", "work.txt"))).toBeTruthy();

    await db.update(executionWorkspaces).set({ status: "archived" }).where(eq(executionWorkspaces.id, row!.id));
    const removed = await runner.run();
    expect(removed.report.categories.isolatedAttempts.candidates).toBe(1);
    await expect(fs.stat(dir)).rejects.toThrow();
  });
});

describe("disk reaper schedule", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("disk-reaper-schedule-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: randomUUID(), name: "Schedule co", issuePrefix: "SCHED" });
  }, 240_000);
  afterAll(async () => { await temporary?.cleanup(); });

  const empty = { candidates: 0, bytes: 0, freedBytes: 0, failed: 0, entries: [], kept: {} };
  const report = { dryRun: true, categories: { tmp: empty, isolatedAttempts: empty, runLogs: empty, backups: empty } };

  async function setLastPass(at: Date) {
    const docIds = await db.select({ id: issueDocuments.documentId }).from(issueDocuments)
      .innerJoin(issues, eq(issues.id, issueDocuments.issueId)).where(eq(issues.originKind, DISK_ALERT_ORIGIN_KIND));
    await db.update(documents).set({ updatedAt: at }).where(inArray(documents.id, docIds.map((d) => d.id)));
  }

  async function restart(startedAt: number) {
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: () => {} });
    const pass = vi.fn(async () => ({ enabled: true }));
    await registerInstanceDiskReaperWork(db, coordinator, { pass, startedAt }).ready;
    return { coordinator, pass };
  }

  it("schedules no pass on restart before 24 h after the last report document", async () => {
    await createDiskReaperReportPoster(db)(report);
    const lastPass = new Date(Date.now() - 60 * 60 * 1000);
    await setLastPass(lastPass);

    const { coordinator, pass } = await restart(Date.now() - 60 * 60 * 1000);
    expect(pass).not.toHaveBeenCalled();
    expect(coordinator.nextWakeAt()).toBe(lastPass.getTime() + INSTANCE_DISK_REAPER_INTERVAL_MS);
    await coordinator.stop();
  });

  it("runs a pass on restart once the last report is 24 h old, then waits a full day", async () => {
    await setLastPass(new Date(Date.now() - INSTANCE_DISK_REAPER_INTERVAL_MS - 60_000));
    const before = Date.now();
    const { coordinator, pass } = await restart(Date.now() - 60 * 60 * 1000);
    expect(pass).toHaveBeenCalledTimes(1);
    expect(coordinator.nextWakeAt()).toBeGreaterThanOrEqual(before + INSTANCE_DISK_REAPER_INTERVAL_MS);
    await coordinator.stop();
  });

  it("goes quiet while the reaper is disabled", async () => {
    await setLastPass(new Date(Date.now() - INSTANCE_DISK_REAPER_INTERVAL_MS - 60_000));
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: () => {} });
    const pass = vi.fn(async () => ({ enabled: false }));
    await registerInstanceDiskReaperWork(db, coordinator, { pass, startedAt: Date.now() - 60 * 60 * 1000 }).ready;
    expect(pass).toHaveBeenCalledTimes(1);
    expect(coordinator.nextWakeAt()).toBeNull();
    await coordinator.stop();
  });
});
