import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DISK_REAPER_SETTINGS, type DiskReaperSettings } from "@paperclipai/shared";
import { HEARTBEAT_RUN_SCRATCH_MARKER } from "./run-scratch.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_LISTED_ENTRIES = 25;
const TMP_PREFIXES = ["paperclip-ai-", "paperclip-run-", "paperclip-ssh-", "paperclip-bridge-"] as const;
// `paperclip-pre-fork-<stamp>.dump` is the one marked dump on record; the board
// names a dump to keep through the same `-pre-` word.
const PRE_MIGRATION_DUMP = /-pre-/;
const DUMP_FILE = /\.(sql|sql\.gz|dump)$/;

export type DiskReaperCategory = "tmp" | "isolatedAttempts" | "runLogs" | "backups";

export interface DiskReaperEntry { path: string; bytes: number; reason: string }
export interface DiskReaperCategoryReport {
  candidates: number;
  bytes: number;
  freedBytes: number;
  failed: number;
  entries: DiskReaperEntry[];
}
export interface DiskReaperReport {
  dryRun: boolean;
  categories: Record<DiskReaperCategory, DiskReaperCategoryReport>;
}

/** A heartbeat run that still holds files: queued, running or waiting to retry. */
export interface DiskReaperLiveRun { id: string; companyId: string; createdAt: Date }

export interface DiskReaperDeps {
  settings: DiskReaperSettings;
  now: Date;
  tmpRoot: string;
  instanceRoot: string;
  backupDir: string;
  runLogRoot: string;
  liveRuns(): Promise<DiskReaperLiveRun[]>;
  /** True when the attempt id resolves to an execution workspace that is still in use. */
  attemptWorkspaceActive(attemptId: string): Promise<boolean>;
  /** Paths the current process uses; a dir that is or holds one is never removed. */
  protectedPaths: string[];
}

export function resolveDiskReaperSettings(stored: Partial<DiskReaperSettings> | undefined): DiskReaperSettings {
  return { ...DEFAULT_DISK_REAPER_SETTINGS, ...stored };
}

export function isPreMigrationDump(name: string): boolean {
  return PRE_MIGRATION_DUMP.test(name);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(1)} ${units[unit]}`;
}

interface Footprint { bytes: number; newestMtimeMs: number }

/** Apparent size and the newest file mtime under `target`; symlinks are counted, never followed. */
async function footprint(target: string): Promise<Footprint> {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory()) return { bytes: stat.size, newestMtimeMs: stat.mtimeMs };
  let bytes = 0;
  let newestMtimeMs = stat.mtimeMs;
  for (const name of await fs.readdir(target).catch(() => [] as string[])) {
    const child = await footprint(path.join(target, name)).catch(() => null);
    if (!child) continue;
    bytes += child.bytes;
    newestMtimeMs = Math.max(newestMtimeMs, child.newestMtimeMs);
  }
  return { bytes, newestMtimeMs };
}

async function readdirSafe(dir: string): Promise<string[]> {
  return fs.readdir(dir).catch(() => []);
}

async function walkFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const name of await readdirSafe(dir)) {
    const full = path.join(dir, name);
    const stat = await fs.lstat(full).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) files.push(...await walkFiles(full));
    else if (stat.isFile()) files.push(full);
  }
  return files;
}

function holdsProtectedPath(dir: string, protectedPaths: string[]): boolean {
  return protectedPaths.some((candidate) => {
    const relative = path.relative(dir, path.resolve(candidate));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

async function readScratchRunId(dir: string): Promise<string | null> {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER), "utf8")) as { runId?: unknown };
    return typeof marker.runId === "string" ? marker.runId : null;
  } catch {
    return null;
  }
}

const RUN_DIR_PREFIX = /-([0-9a-f]{8}-[0-9a-f]{3})-[A-Za-z0-9]{6}$/;
const AI_DIR_COMPANY = /^paperclip-ai-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/;

/**
 * Why a temp dir must stay, or null when nothing live can own it. A dir is
 * created when its run starts, so a live run that started after the dir was
 * last written cannot hold it. A dir that names its run or company is judged
 * against that run or company only; an ssh or bridge dir names neither, so any
 * older live run keeps it.
 */
async function liveOwnerOfTmpDir(dir: string, name: string, newestMtimeMs: number, liveRuns: DiskReaperLiveRun[]): Promise<string | null> {
  const couldOwn = (runs: DiskReaperLiveRun[]) => runs.some((run) => run.createdAt.getTime() <= newestMtimeMs);
  if (name.startsWith("paperclip-run-")) {
    const runId = await readScratchRunId(dir);
    if (runId) return liveRuns.some((run) => run.id === runId) ? `run ${runId} is live` : null;
    const prefix = RUN_DIR_PREFIX.exec(name)?.[1];
    if (prefix) return liveRuns.some((run) => run.id.startsWith(prefix)) ? `run ${prefix}... is live` : null;
  }
  const company = AI_DIR_COMPANY.exec(name)?.[1];
  const scope = company ? liveRuns.filter((run) => run.companyId === company) : liveRuns;
  return couldOwn(scope) ? "a live run old enough to own it exists" : null;
}

function emptyReport(): DiskReaperCategoryReport {
  return { candidates: 0, bytes: 0, freedBytes: 0, failed: 0, entries: [] };
}

async function removeCandidate(report: DiskReaperCategoryReport, entry: DiskReaperEntry, dryRun: boolean) {
  report.candidates += 1;
  report.bytes += entry.bytes;
  if (report.entries.length < MAX_LISTED_ENTRIES) report.entries.push(entry);
  if (dryRun) return;
  try {
    await fs.rm(entry.path, { recursive: true, force: true });
    report.freedBytes += entry.bytes;
  } catch {
    report.failed += 1;
  }
}

async function pruneEmptyParents(start: string, stopAt: string) {
  let dir = start;
  while (dir.startsWith(stopAt + path.sep)) {
    if (await fs.rmdir(dir).then(() => false, () => true)) return;
    dir = path.dirname(dir);
  }
}

async function sweepTmp(deps: DiskReaperDeps, liveRuns: DiskReaperLiveRun[], report: DiskReaperCategoryReport) {
  const idleMs = deps.settings.idleHours * HOUR_MS;
  for (const name of await readdirSafe(deps.tmpRoot)) {
    if (!TMP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const dir = path.join(deps.tmpRoot, name);
    const stat = await fs.lstat(dir).catch(() => null);
    if (!stat?.isDirectory() || holdsProtectedPath(dir, deps.protectedPaths)) continue;
    const { bytes, newestMtimeMs } = await footprint(dir);
    if (deps.now.getTime() - newestMtimeMs < idleMs) continue;
    if (await liveOwnerOfTmpDir(dir, name, newestMtimeMs, liveRuns)) continue;
    await removeCandidate(report, { path: dir, bytes, reason: "idle temp dir with no live run" }, deps.settings.dryRun);
  }
}

async function sweepAttempts(deps: DiskReaperDeps, liveRuns: DiskReaperLiveRun[], report: DiskReaperCategoryReport) {
  const root = path.join(deps.instanceRoot, "isolated-workspace-attempts");
  const idleMs = deps.settings.idleHours * HOUR_MS;
  const liveIds = new Set(liveRuns.map((run) => run.id));
  for (const company of await readdirSafe(root)) {
    for (const issue of await readdirSafe(path.join(root, company))) {
      for (const attempt of await readdirSafe(path.join(root, company, issue))) {
        const dir = path.join(root, company, issue, attempt);
        const stat = await fs.lstat(dir).catch(() => null);
        if (!stat?.isDirectory() || holdsProtectedPath(dir, deps.protectedPaths)) continue;
        const { bytes, newestMtimeMs } = await footprint(dir);
        if (deps.now.getTime() - newestMtimeMs < idleMs) continue;
        if (liveIds.has(attempt) || await deps.attemptWorkspaceActive(attempt)) continue;
        await removeCandidate(report, { path: dir, bytes, reason: "idle attempt with no live run or workspace" }, deps.settings.dryRun);
      }
      if (!deps.settings.dryRun) await pruneEmptyParents(path.join(root, company, issue), root);
    }
  }
}

async function sweepRunLogs(deps: DiskReaperDeps, liveRuns: DiskReaperLiveRun[], report: DiskReaperCategoryReport) {
  const cutoff = deps.now.getTime() - deps.settings.runLogRetentionDays * DAY_MS;
  const liveIds = new Set(liveRuns.map((run) => run.id));
  for (const file of await walkFiles(deps.runLogRoot)) {
    if (!file.endsWith(".ndjson") || liveIds.has(path.basename(file, ".ndjson"))) continue;
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat || stat.mtimeMs >= cutoff) continue;
    await removeCandidate(report, { path: file, bytes: stat.size, reason: "run log past retention" }, deps.settings.dryRun);
    if (!deps.settings.dryRun) await pruneEmptyParents(path.dirname(file), deps.runLogRoot);
  }
}

/**
 * Keeps the newest `backupKeepCount` dumps, caps the tiered keep of the backup
 * runner and never removes the newest dump or a pre-migration one. A
 * pre-migration dump does not count toward the keep count.
 */
async function sweepBackups(deps: DiskReaperDeps, report: DiskReaperCategoryReport) {
  const dumps: Array<{ file: string; bytes: number; mtimeMs: number }> = [];
  for (const name of await readdirSafe(deps.backupDir)) {
    if (!DUMP_FILE.test(name) || isPreMigrationDump(name)) continue;
    const file = path.join(deps.backupDir, name);
    const stat = await fs.lstat(file).catch(() => null);
    if (stat?.isFile()) dumps.push({ file, bytes: stat.size, mtimeMs: stat.mtimeMs });
  }
  dumps.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const dump of dumps.slice(Math.max(1, deps.settings.backupKeepCount))) {
    await removeCandidate(report, { path: dump.file, bytes: dump.bytes, reason: "beyond the newest dumps" }, deps.settings.dryRun);
  }
}

/** One pass over the four categories. Dry run measures and lists; it deletes nothing. */
export async function sweepInstanceDisk(deps: DiskReaperDeps): Promise<DiskReaperReport> {
  const report: DiskReaperReport = {
    dryRun: deps.settings.dryRun,
    categories: { tmp: emptyReport(), isolatedAttempts: emptyReport(), runLogs: emptyReport(), backups: emptyReport() },
  };
  if (!deps.settings.enabled) return report;
  const liveRuns = await deps.liveRuns();
  await sweepTmp(deps, liveRuns, report.categories.tmp);
  await sweepAttempts(deps, liveRuns, report.categories.isolatedAttempts);
  await sweepRunLogs(deps, liveRuns, report.categories.runLogs);
  await sweepBackups(deps, report.categories.backups);
  return report;
}

const CATEGORY_LABELS: Record<DiskReaperCategory, string> = {
  tmp: "temp dirs",
  isolatedAttempts: "isolated workspace attempts",
  runLogs: "run logs",
  backups: "database dumps",
};

export function formatDiskReaperReport(report: DiskReaperReport): string {
  const lines = [report.dryRun ? "Disk reaper dry run: nothing was deleted." : "Disk reaper run complete."];
  let total = 0;
  for (const [category, label] of Object.entries(CATEGORY_LABELS) as Array<[DiskReaperCategory, string]>) {
    const entry = report.categories[category];
    total += report.dryRun ? entry.bytes : entry.freedBytes;
    const outcome = report.dryRun
      ? `${entry.candidates} would be removed, ${formatBytes(entry.bytes)}`
      : `${formatBytes(entry.freedBytes)} freed from ${entry.candidates} (${entry.failed} failed)`;
    lines.push(`- ${label}: ${outcome}`);
    for (const item of entry.entries) lines.push(`  - ${item.path} (${formatBytes(item.bytes)})`);
    if (entry.candidates > entry.entries.length) lines.push(`  - ... and ${entry.candidates - entry.entries.length} more`);
  }
  lines.push(`Total ${report.dryRun ? "reclaimable" : "freed"}: ${formatBytes(total)}`);
  return lines.join("\n");
}

export interface DiskConsumer { path: string; bytes: number }

export interface DiskPressureCard { title: string; summary: string; detailsMarkdown: string; usedPercent: number }

export async function postDiskPressureAlert(input: {
  settings: DiskReaperSettings;
  usedPercent: number;
  mountPath: string;
  consumers: DiskConsumer[];
  /** Creates the board card; resolves `pending_exists` when an unanswered one is already open. */
  post(card: DiskPressureCard): Promise<"posted" | "pending_exists">;
}): Promise<"posted" | "pending_exists" | "below_threshold"> {
  if (input.usedPercent <= input.settings.diskAlertPercent) return "below_threshold";
  const rounded = Math.round(input.usedPercent);
  const top = [...input.consumers].sort((a, b) => b.bytes - a.bytes).slice(0, 8);
  return input.post({
    usedPercent: rounded,
    title: `Disk ${rounded}% full on ${input.mountPath}`,
    summary: `Disk use passed ${input.settings.diskAlertPercent}%. Free space, or raise the limit in instance settings.`,
    detailsMarkdown: ["Top consumers:", ...top.map((item) => `- \`${item.path}\`: ${formatBytes(item.bytes)}`)].join("\n"),
  });
}

/** Percent of the filesystem holding `target` in use, as `df` counts it. */
export async function readDiskUsedPercent(target: string): Promise<number> {
  const stats = await fs.statfs(target);
  const used = stats.blocks - stats.bfree;
  return used + stats.bavail === 0 ? 0 : (used / (used + stats.bavail)) * 100;
}

/** Sizes of each top-level dir under the instance root and its `data` dir, and of the reapable temp dirs. */
export async function measureTopConsumers(deps: Pick<DiskReaperDeps, "instanceRoot" | "tmpRoot">): Promise<DiskConsumer[]> {
  const consumers: DiskConsumer[] = [];
  const dataRoot = path.join(deps.instanceRoot, "data");
  for (const parent of [deps.instanceRoot, dataRoot]) {
    for (const name of await readdirSafe(parent)) {
      if (parent === deps.instanceRoot && name === "data") continue;
      const full = path.join(parent, name);
      const size = await footprint(full).catch(() => null);
      if (size) consumers.push({ path: full, bytes: size.bytes });
    }
  }
  let tmpBytes = 0;
  for (const name of await readdirSafe(deps.tmpRoot)) {
    if (!TMP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    tmpBytes += (await footprint(path.join(deps.tmpRoot, name)).catch(() => ({ bytes: 0 }))).bytes;
  }
  consumers.push({ path: `${deps.tmpRoot}/paperclip-*`, bytes: tmpBytes });
  return consumers;
}
