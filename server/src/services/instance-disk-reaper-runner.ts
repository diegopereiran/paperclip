import os from "node:os";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companies,
  executionWorkspaces,
  heartbeatRuns,
  instanceUserRoles,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import {
  formatDiskReaperReport,
  measureTopConsumers,
  postDiskPressureAlert,
  readDiskUsedPercent,
  resolveDiskReaperSettings,
  sweepInstanceDisk,
  type DiskPressureCard,
  type DiskReaperDeps,
  type DiskReaperReport,
} from "./instance-disk-reaper.js";
import { instanceSettingsService } from "./instance-settings.js";
import { issueService } from "./issues.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { resolveRunLogBasePath } from "./run-log-store.js";

export const INSTANCE_DISK_REAPER_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const INSTANCE_DISK_REAPER_STARTUP_DELAY_MS = 10 * 60 * 1000;
export const DISK_ALERT_ORIGIN_KIND = "instance_disk_alert";
const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"];

/** Paths the server process itself writes to while it runs. */
function currentProcessPaths(): string[] {
  return [
    os.tmpdir(), process.cwd(),
    ...["TMPDIR", "TMP", "TEMP", "PAPERCLIP_RUN_SCRATCH_DIR", "PAPERCLIP_TASK_SCRATCH_DIR", "PAPERCLIP_SCRATCH_DIR", "PAPERCLIP_TMPDIR"]
      .map((key) => process.env[key]).filter((value): value is string => Boolean(value)),
  ];
}

/**
 * Posts one board card on a standing instance-level issue in the oldest active
 * company, and none while an earlier card there is still unanswered.
 */
export function createDiskAlertCardPoster(db: Db) {
  return async (card: DiskPressureCard): Promise<"posted" | "pending_exists"> => {
    const [company] = await db.select({ id: companies.id }).from(companies)
      .where(ne(companies.status, "archived")).orderBy(asc(companies.createdAt)).limit(1);
    if (!company) throw new Error("No active company can hold the disk alert card");
    const issueSvc = issueService(db);
    let [standing] = await db.select({ id: issues.id, companyId: issues.companyId }).from(issues)
      .where(and(
        eq(issues.companyId, company.id),
        eq(issues.originKind, DISK_ALERT_ORIGIN_KIND),
        inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
      )).limit(1);
    if (!standing) {
      const created = await issueSvc.create(company.id, {
        title: "Disk space alert",
        description: "Instance-wide disk usage alerts. The disk reaper posts a card here when disk use passes the limit in instance settings.",
        status: "todo",
        priority: "high",
        originKind: DISK_ALERT_ORIGIN_KIND,
      });
      standing = { id: created.id, companyId: company.id };
    }
    const [pending] = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.issueId, standing.id),
        eq(issueThreadInteractions.kind, "request_confirmation"),
        eq(issueThreadInteractions.status, "pending"),
      )).limit(1);
    if (pending) return "pending_exists";
    const [admin] = await db.select({ userId: instanceUserRoles.userId }).from(instanceUserRoles)
      .where(eq(instanceUserRoles.role, "instance_admin")).orderBy(asc(instanceUserRoles.createdAt)).limit(1);
    await issueThreadInteractionService(db).create(standing, {
      kind: "request_confirmation",
      idempotencyKey: `disk-alert:${Date.now()}`,
      title: card.title,
      summary: card.summary,
      continuationPolicy: "none",
      resolverPolicy: "human_only",
      // A no-login install has the implicit board user.
      addresseeUserId: admin?.userId ?? "local-board",
      payload: {
        version: 1,
        prompt: card.summary,
        detailsMarkdown: card.detailsMarkdown,
        acceptLabel: "Acknowledge",
        rejectLabel: "Dismiss",
      },
    }, { systemId: "instance-disk-reaper" });
    return "posted";
  };
}

export interface InstanceDiskReaperResult {
  report: DiskReaperReport;
  text: string;
  alert: Awaited<ReturnType<typeof postDiskPressureAlert>> | "failed";
}

export function instanceDiskReaperRunner(db: Db, options: { backupDir: string; tmpRoot?: string }) {
  const tmpRoot = options.tmpRoot ?? os.tmpdir();
  const instanceRoot = resolvePaperclipInstanceRoot();

  const deps = (settings: DiskReaperDeps["settings"]): DiskReaperDeps => ({
    settings,
    now: new Date(),
    tmpRoot,
    instanceRoot,
    backupDir: options.backupDir,
    runLogRoot: resolveRunLogBasePath(),
    liveRuns: async () => db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, createdAt: heartbeatRuns.createdAt })
      .from(heartbeatRuns).where(inArray(heartbeatRuns.status, LIVE_RUN_STATUSES)),
    attemptWorkspaceActive: async (attemptId) => {
      if (!/^[0-9a-f-]{36}$/i.test(attemptId)) return false;
      const [row] = await db.select({ id: executionWorkspaces.id }).from(executionWorkspaces)
        .where(and(eq(executionWorkspaces.id, attemptId), ne(executionWorkspaces.status, "archived"))).limit(1);
      return Boolean(row);
    },
    protectedPaths: currentProcessPaths(),
  });

  return {
    /** One daily pass: sweep, then the disk-usage alert. Never throws for the alert. */
    async run(): Promise<InstanceDiskReaperResult> {
      const settings = resolveDiskReaperSettings((await instanceSettingsService(db).getGeneral()).diskReaper);
      const report = await sweepInstanceDisk(deps(settings));
      let alert: InstanceDiskReaperResult["alert"] = "below_threshold";
      if (settings.enabled) {
        try {
          const usedPercent = await readDiskUsedPercent(instanceRoot);
          // Measure the consumers only when the card will be posted.
          alert = await postDiskPressureAlert({
            settings, usedPercent, mountPath: instanceRoot,
            consumers: usedPercent > settings.diskAlertPercent ? await measureTopConsumers({ instanceRoot, tmpRoot }) : [],
            post: createDiskAlertCardPoster(db),
          });
        } catch {
          alert = "failed";
        }
      }
      return { report, text: formatDiskReaperReport(report), alert };
    },
  };
}
