import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, instanceUserRoles, issueThreadInteractions, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { DISK_ALERT_ORIGIN_KIND, createDiskAlertCardPoster } from "./instance-disk-reaper-runner.js";

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
});
