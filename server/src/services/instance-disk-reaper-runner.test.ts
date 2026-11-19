import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issueComments, issueDocuments, issueThreadInteractions, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { DISK_ALERT_ORIGIN_KIND, createDiskAlertCardPoster, createDiskReaperReportPoster } from "./instance-disk-reaper-runner.js";

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
    expect(real!.body).toContain("kept 2: owned by a live run");
    expect(real!.body).toContain("... and 10 more");
    expect(real!.body).not.toContain("paperclip-run-25");
    expect(real!.body).toContain("#document-disk-reaper-2026-11-19");
    expect(real!.body.length).toBeLessThan(8200);
    const docs = await db.select().from(issueDocuments).where(eq(issueDocuments.issueId, standing[0]!.id));
    expect(docs.map((d) => d.key)).toEqual(["disk-reaper-2026-11-19"]);
  });
});
