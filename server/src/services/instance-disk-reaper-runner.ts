import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, asc, desc, eq, inArray, like, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companies,
  documents,
  executionWorkspaces,
  heartbeatRuns,
  instanceUserRoles,
  issueDocuments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
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
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { documentService } from "./documents.js";
import { instanceSettingsService } from "./instance-settings.js";
import { issueService } from "./issues.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { resolveRunLogBasePath } from "./run-log-store.js";

export const INSTANCE_DISK_REAPER_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INSTANCE_DISK_REAPER_STARTUP_DELAY_MS = 10 * 60 * 1000;
const INSTANCE_DISK_REAPER_RETRY_MS = 60 * 60 * 1000;
export const DISK_ALERT_ORIGIN_KIND = "instance_disk_alert";
const REPORT_DOCUMENT_PREFIX = "disk-reaper-";
const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"];

/** Paths the server process itself writes to while it runs. */
function currentProcessPaths(): string[] {
  return [
    os.tmpdir(), process.cwd(),
    ...["TMPDIR", "TMP", "TEMP", "PAPERCLIP_RUN_SCRATCH_DIR", "PAPERCLIP_TASK_SCRATCH_DIR", "PAPERCLIP_SCRATCH_DIR", "PAPERCLIP_TMPDIR"]
      .map((key) => process.env[key]).filter((value): value is string => Boolean(value)),
  ];
}

/** The standing instance-level issue in the oldest active company; created on first use and kept open. */
async function findOrCreateStandingIssue(db: Db): Promise<{ id: string; companyId: string }> {
  const [company] = await db.select({ id: companies.id }).from(companies)
    .where(ne(companies.status, "archived")).orderBy(asc(companies.createdAt)).limit(1);
  if (!company) throw new Error("No active company can hold the disk alert card");
  const [standing] = await db.select({ id: issues.id, companyId: issues.companyId }).from(issues)
    .where(and(
      eq(issues.companyId, company.id),
      eq(issues.originKind, DISK_ALERT_ORIGIN_KIND),
      inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
    )).limit(1);
  if (standing) return standing;
  const created = await issueService(db).create(company.id, {
    title: "Disk space alert",
    description: "Instance-wide disk reaper reports and disk usage alerts. The disk reaper comments here after every pass and posts a card when disk use passes the limit in instance settings.",
    status: "todo",
    priority: "high",
    originKind: DISK_ALERT_ORIGIN_KIND,
  });
  return { id: created.id, companyId: company.id };
}

/**
 * Posts a pass report as a comment on the standing issue: totals and kept
 * reasons only, so a daily comment keeps the thread small. The full path list
 * goes to a linked document, whose update time records the pass.
 */
export function createDiskReaperReportPoster(db: Db) {
  return async (report: DiskReaperReport, now: Date = new Date()): Promise<void> => {
    const standing = await findOrCreateStandingIssue(db);
    const key = `${REPORT_DOCUMENT_PREFIX}${now.toISOString().slice(0, 10)}`;
    const documentsSvc = documentService(db);
    // A second pass on the same day replaces that day's document.
    const existing = await documentsSvc.getIssueDocumentByKey(standing.id, key);
    await documentsSvc.upsertIssueDocument({
      issueId: standing.id,
      baseRevisionId: existing?.latestRevisionId ?? null,
      key,
      title: `Disk reaper ${report.dryRun ? "dry run" : "run"} ${key.slice(REPORT_DOCUMENT_PREFIX.length)}`,
      format: "markdown",
      body: formatDiskReaperReport(report, Infinity),
      changeSummary: "Disk reaper full path list",
    });
    const body = `${formatDiskReaperReport(report, 0)}\n\nFull path list: [${key}](#document-${key})`;
    await issueService(db).addComment(standing.id, body, {});
  };
}

/**
 * Posts one board card on the standing issue, and none while an earlier card
 * there is still unanswered.
 */
export function createDiskAlertCardPoster(db: Db) {
  return async (card: DiskPressureCard): Promise<"posted" | "pending_exists"> => {
    const standing = await findOrCreateStandingIssue(db);
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
  enabled: boolean;
  report: DiskReaperReport;
  text: string;
  alert: Awaited<ReturnType<typeof postDiskPressureAlert>> | "failed";
}

export function instanceDiskReaperRunner(
  db: Db,
  options: { backupDir: string; tmpRoot?: string; instanceRoot?: string; runLogRoot?: string },
) {
  const tmpRoot = options.tmpRoot ?? os.tmpdir();
  const instanceRoot = options.instanceRoot ?? resolvePaperclipInstanceRoot();

  const deps = (settings: DiskReaperDeps["settings"]): DiskReaperDeps => ({
    settings,
    now: new Date(),
    tmpRoot,
    instanceRoot,
    backupDir: options.backupDir,
    runLogRoot: options.runLogRoot ?? resolveRunLogBasePath(),
    liveRuns: async () => db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, createdAt: heartbeatRuns.createdAt })
      .from(heartbeatRuns).where(inArray(heartbeatRuns.status, LIVE_RUN_STATUSES)),
    attemptWorkspaceActive: async (attemptId, attemptDir) => {
      // Workspace paths are built from the real instance root (isolated-task-directory.ts).
      const dir = await fs.realpath(attemptDir).catch(() => attemptDir);
      const inside = (column: typeof executionWorkspaces.cwd | typeof executionWorkspaces.providerRef) =>
        or(eq(column, dir), sql`starts_with(${column}, ${dir + path.sep})`);
      const [row] = await db.select({ id: executionWorkspaces.id }).from(executionWorkspaces)
        .where(and(
          ne(executionWorkspaces.status, "archived"),
          or(
            // A provider fresh workspace takes the attempt id as its row id.
            /^[0-9a-f-]{36}$/i.test(attemptId) ? eq(executionWorkspaces.id, attemptId) : undefined,
            // A task workspace has its own id and works inside the attempt dir.
            inside(executionWorkspaces.cwd),
            inside(executionWorkspaces.providerRef),
          ),
        )).limit(1);
      return Boolean(row);
    },
    protectedPaths: currentProcessPaths(),
  });

  return {
    /** One daily pass: sweep, then the disk-usage alert. Never throws for the alert. */
    async run(): Promise<InstanceDiskReaperResult> {
      const settings = resolveDiskReaperSettings((await instanceSettingsService(db).getGeneral()).diskReaper);
      const report = await sweepInstanceDisk(deps(settings));
      if (settings.enabled) {
        await createDiskReaperReportPoster(db)(report).catch((err) => {
          logger.warn({ err }, "disk reaper could not post its report comment");
        });
      }
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
        } catch (err) {
          logger.warn({ err }, "disk reaper could not post the disk usage alert card");
          alert = "failed";
        }
      }
      return { enabled: settings.enabled, report, text: formatDiskReaperReport(report), alert };
    },
  };
}

/** Update time of the newest report document: the durable record of the last pass. */
async function lastDiskReaperPassAt(db: Db): Promise<number | null> {
  const [row] = await db.select({ at: documents.updatedAt }).from(issueDocuments)
    .innerJoin(issues, eq(issues.id, issueDocuments.issueId))
    .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
    .where(and(eq(issues.originKind, DISK_ALERT_ORIGIN_KIND), like(issueDocuments.key, `${REPORT_DOCUMENT_PREFIX}%`)))
    .orderBy(desc(documents.updatedAt)).limit(1);
  return row ? row.at.getTime() : null;
}

/**
 * Runs the pass once a day on the shared delivery scheduler. The deadline is
 * the last report document + 24 h, so a restart does not add a pass, and never
 * earlier than the startup delay. A disabled reaper registers no deadline; a
 * change to the setting takes effect at the next server start.
 */
export function registerInstanceDiskReaperWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  input: { pass: () => Promise<{ enabled: boolean }>; startedAt?: number },
) {
  const earliest = (input.startedAt ?? Date.now()) + INSTANCE_DISK_REAPER_STARTUP_DELAY_MS;
  let next: number | null = null;
  return coordinator.register(DELIVERY_QUEUES.instanceDiskReaper, {
    retryMs: INSTANCE_DISK_REAPER_RETRY_MS,
    pausePassiveMaintenance: true,
    hasPending: async () => false,
    nextRunAt: () => next,
    run: async () => {
      const last = await lastDiskReaperPassAt(db);
      const due = Math.max(earliest, last === null ? 0 : last + INSTANCE_DISK_REAPER_INTERVAL_MS);
      if (Date.now() < due) { next = due; return; }
      next = null;
      const { enabled } = await input.pass();
      // Count from the pass, not the document: a failed report post must not retry at once.
      if (enabled) next = Date.now() + INSTANCE_DISK_REAPER_INTERVAL_MS;
    },
  });
}
