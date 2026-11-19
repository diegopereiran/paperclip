import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DISK_REAPER_SETTINGS, patchInstanceGeneralSettingsSchema } from "@paperclipai/shared";
import {
  formatDiskReaperReport,
  isPreMigrationDump,
  postDiskPressureAlert,
  resolveDiskReaperSettings,
  sweepInstanceDisk,
  type DiskReaperDeps,
} from "./instance-disk-reaper.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-19T12:00:00Z");
const COMPANY = "ab899dcd-4864-4aa7-8a78-b90e0c957b39";
const RUN_A = "7d55bb22-c6e3-4f34-b58c-b07c16d4fac1";

let root: string;
let tmpRoot: string;
let instanceRoot: string;
let backupDir: string;
let runLogRoot: string;

async function put(file: string, size: number, ageMs: number) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.alloc(size, 1));
  const when = new Date(NOW.getTime() - ageMs);
  await fs.utimes(file, when, when);
}
/** A dir whose every entry is `ageMs` old. */
async function putDir(dir: string, size: number, ageMs: number) {
  await put(path.join(dir, "data.bin"), size, ageMs);
  const when = new Date(NOW.getTime() - ageMs);
  await fs.utimes(dir, when, when);
}
const exists = (p: string) => fs.stat(p).then(() => true, () => false);

function deps(over: Partial<DiskReaperDeps> = {}): DiskReaperDeps {
  return {
    settings: { ...DEFAULT_DISK_REAPER_SETTINGS, dryRun: false },
    now: NOW,
    tmpRoot,
    instanceRoot,
    backupDir,
    runLogRoot,
    liveRuns: async () => [],
    attemptWorkspaceActive: async () => false,
    protectedPaths: [],
    ...over,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "disk-reaper-test-"));
  tmpRoot = path.join(root, "tmp");
  instanceRoot = path.join(root, "instance");
  backupDir = path.join(instanceRoot, "data", "backups");
  runLogRoot = path.join(instanceRoot, "data", "run-logs");
  await fs.mkdir(tmpRoot, { recursive: true });
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe("backups", () => {
  async function dumps(count: number) {
    // paperclip-0 is the newest, one per six hours.
    for (let i = 0; i < count; i += 1) {
      await put(path.join(backupDir, `paperclip-2026111${i % 10}-${i}.sql.gz`), 100, (i + 1) * 6 * HOUR);
    }
  }

  it("keeps the newest N dumps and removes the rest, counting bytes", async () => {
    await dumps(10);
    const report = await sweepInstanceDisk(deps());
    expect(report.categories.backups).toMatchObject({ candidates: 3, bytes: 300, freedBytes: 300, kept: { "among the newest dumps": 7 } });
    const left = await fs.readdir(backupDir);
    expect(left).toHaveLength(7);
    // The three oldest are gone, the newest stays.
    expect(left).not.toContain("paperclip-20261119-9.sql.gz");
    expect(left).toContain("paperclip-20261110-0.sql.gz");
  });

  it("never removes the newest dump even with a keep count of zero", async () => {
    await dumps(3);
    await sweepInstanceDisk(deps({ settings: { ...DEFAULT_DISK_REAPER_SETTINGS, dryRun: false, backupKeepCount: 0 } }));
    expect(await fs.readdir(backupDir)).toEqual(["paperclip-20261110-0.sql.gz"]);
  });

  it("never removes a pre-migration dump and does not count it toward the keep count", async () => {
    await dumps(8);
    await put(path.join(backupDir, "paperclip-pre-fork-20260930-231743.dump"), 500, 50 * DAY);
    const report = await sweepInstanceDisk(deps());
    expect(await exists(path.join(backupDir, "paperclip-pre-fork-20260930-231743.dump"))).toBe(true);
    expect(report.categories.backups.candidates).toBe(1);
    expect(isPreMigrationDump("paperclip-pre-fork-20260930-231743.dump")).toBe(true);
    expect(isPreMigrationDump("paperclip-20261119-070721.sql.gz")).toBe(false);
  });
});

describe("run logs", () => {
  it("removes logs older than the retention, keeps newer and live-run logs", async () => {
    await put(path.join(runLogRoot, COMPANY, "agent1", "old.ndjson"), 200, 15 * DAY);
    await put(path.join(runLogRoot, COMPANY, "agent1", "new.ndjson"), 200, 13 * DAY);
    await put(path.join(runLogRoot, COMPANY, "agent1", `${RUN_A}.ndjson`), 200, 30 * DAY);
    const report = await sweepInstanceDisk(deps({
      liveRuns: async () => [{ id: RUN_A, companyId: COMPANY, createdAt: new Date(NOW.getTime() - 30 * DAY) }],
    }));
    expect(report.categories.runLogs).toMatchObject({ candidates: 1, bytes: 200, freedBytes: 200 });
    expect(await exists(path.join(runLogRoot, COMPANY, "agent1", "old.ndjson"))).toBe(false);
    expect(await exists(path.join(runLogRoot, COMPANY, "agent1", "new.ndjson"))).toBe(true);
    expect(await exists(path.join(runLogRoot, COMPANY, "agent1", `${RUN_A}.ndjson`))).toBe(true);
  });
});

describe("isolated workspace attempts", () => {
  const attemptDir = (id: string) => path.join(instanceRoot, "isolated-workspace-attempts", COMPANY, "issue1", id);

  it("removes an idle attempt that has no live run and no workspace row", async () => {
    await putDir(attemptDir("dead"), 400, 2 * DAY);
    const report = await sweepInstanceDisk(deps());
    expect(report.categories.isolatedAttempts).toMatchObject({ candidates: 1, bytes: 400, freedBytes: 400 });
    expect(await exists(attemptDir("dead"))).toBe(false);
  });

  it("keeps a recent attempt, a live run's attempt and an attempt that resolves as a workspace", async () => {
    await putDir(attemptDir("recent"), 10, 2 * HOUR);
    await putDir(attemptDir(RUN_A), 10, 5 * DAY);
    await putDir(attemptDir("workspace-row"), 10, 5 * DAY);
    const report = await sweepInstanceDisk(deps({
      liveRuns: async () => [{ id: RUN_A, companyId: COMPANY, createdAt: new Date(NOW.getTime() - 5 * DAY) }],
      attemptWorkspaceActive: async (id) => id === "workspace-row",
    }));
    expect(report.categories.isolatedAttempts.candidates).toBe(0);
    for (const id of ["recent", RUN_A, "workspace-row"]) expect(await exists(attemptDir(id))).toBe(true);
  });

  it("treats a recently written file inside an old attempt as activity", async () => {
    await putDir(attemptDir("busy"), 10, 5 * DAY);
    await put(path.join(attemptDir("busy"), "workspace", "src", "f.ts"), 10, HOUR);
    await sweepInstanceDisk(deps());
    expect(await exists(attemptDir("busy"))).toBe(true);
  });
});

describe("temp dirs", () => {
  const old = 3 * DAY;
  const created = (ageMs: number) => new Date(NOW.getTime() - ageMs);

  it("removes idle provider, run, ssh and bridge dirs with no live owner, in every prefix", async () => {
    await putDir(path.join(tmpRoot, `paperclip-ai-${COMPANY}-grant-abcdef`), 100, old);
    await putDir(path.join(tmpRoot, "paperclip-run-alp-1-aaaaaaaa-bbb-xyz123"), 100, old);
    await putDir(path.join(tmpRoot, "paperclip-ssh-key-abc123"), 100, old);
    await putDir(path.join(tmpRoot, "paperclip-bridge-asset-abc123"), 100, old);
    const report = await sweepInstanceDisk(deps());
    expect(report.categories.tmp).toMatchObject({ candidates: 4, bytes: 400, freedBytes: 400 });
    expect(await fs.readdir(tmpRoot)).toEqual([]);
  });

  it("never touches dirs outside the four prefixes", async () => {
    await putDir(path.join(tmpRoot, "claude-999"), 100, old);
    await putDir(path.join(tmpRoot, "base.RMjV"), 100, old);
    await sweepInstanceDisk(deps());
    expect((await fs.readdir(tmpRoot)).sort()).toEqual(["base.RMjV", "claude-999"]);
  });

  it("keeps a dir modified within the idle window", async () => {
    await putDir(path.join(tmpRoot, "paperclip-ssh-key-recent"), 100, 2 * HOUR);
    const dir = path.join(tmpRoot, "paperclip-ssh-key-old001");
    await putDir(dir, 100, old);
    await put(path.join(dir, "nested", "touched"), 1, HOUR);
    await sweepInstanceDisk(deps());
    expect((await fs.readdir(tmpRoot)).sort()).toEqual(["paperclip-ssh-key-old001", "paperclip-ssh-key-recent"]);
  });

  it("keeps a run scratch dir whose marker names a live run, whatever its age", async () => {
    const dir = path.join(tmpRoot, "paperclip-run-alp-2-7d55bb22-c6e-abc123");
    await putDir(dir, 100, old);
    await put(path.join(dir, ".paperclip-run-scratch.json"), 1, old);
    await fs.writeFile(path.join(dir, ".paperclip-run-scratch.json"), JSON.stringify({
      version: 1, companyId: COMPANY, agentId: "a", runId: RUN_A, createdAt: created(old).toISOString(),
    }));
    await fs.utimes(path.join(dir, ".paperclip-run-scratch.json"), created(old), created(old));
    await sweepInstanceDisk(deps({ liveRuns: async () => [{ id: RUN_A, companyId: COMPANY, createdAt: created(old) }] }));
    expect(await exists(dir)).toBe(true);
  });

  it("maps an unmarked run dir to its run by the run id prefix in its name", async () => {
    const dir = path.join(tmpRoot, "paperclip-run-alp-2-7d55bb22-c6e-abc123");
    await putDir(dir, 100, old);
    await sweepInstanceDisk(deps({ liveRuns: async () => [{ id: RUN_A, companyId: COMPANY, createdAt: created(old) }] }));
    expect(await exists(dir)).toBe(true);
  });

  it("keeps a provider home while its company has a run old enough to own it", async () => {
    const dir = path.join(tmpRoot, `paperclip-ai-${COMPANY}-grant-abcdef`);
    await putDir(dir, 100, old);
    const other = "11111111-1111-4111-8111-111111111111";
    // A run that started after the dir was last touched cannot own it.
    await sweepInstanceDisk(deps({ liveRuns: async () => [{ id: "r1", companyId: COMPANY, createdAt: created(HOUR) }] }));
    expect(await exists(dir)).toBe(false);
    await putDir(dir, 100, old);
    await sweepInstanceDisk(deps({ liveRuns: async () => [{ id: "r2", companyId: other, createdAt: created(old) }] }));
    expect(await exists(dir)).toBe(false);
    await putDir(dir, 100, old);
    await sweepInstanceDisk(deps({ liveRuns: async () => [{ id: "r3", companyId: COMPANY, createdAt: created(old) }] }));
    expect(await exists(dir)).toBe(true);
  });

  it("keeps unmappable ssh and bridge dirs while any run old enough to own them is live", async () => {
    const dir = path.join(tmpRoot, "paperclip-bridge-asset-abc123");
    await putDir(dir, 100, old);
    await sweepInstanceDisk(deps({ liveRuns: async () => [{ id: "r1", companyId: COMPANY, createdAt: created(old) }] }));
    expect(await exists(dir)).toBe(true);
  });

  it("never removes the current process's dir or a dir holding a protected path", async () => {
    const mine = path.join(tmpRoot, "paperclip-run-alp-3-current-abc123");
    const parent = path.join(tmpRoot, "paperclip-ssh-key-parent1");
    await putDir(mine, 100, old);
    await putDir(parent, 100, old);
    await sweepInstanceDisk(deps({ protectedPaths: [mine, path.join(parent, "inner")] }));
    expect((await fs.readdir(tmpRoot)).sort()).toEqual(["paperclip-run-alp-3-current-abc123", "paperclip-ssh-key-parent1"]);
  });
});

describe("dry run and report", () => {
  it("lists every category's candidates and bytes and deletes nothing", async () => {
    await put(path.join(runLogRoot, COMPANY, "a", "old.ndjson"), 200, 20 * DAY);
    await putDir(path.join(tmpRoot, "paperclip-ssh-key-old001"), 100, 3 * DAY);
    await putDir(path.join(instanceRoot, "isolated-workspace-attempts", COMPANY, "i", "dead"), 50, 3 * DAY);
    for (let i = 0; i < 9; i += 1) await put(path.join(backupDir, `paperclip-2026110${i}-0.sql.gz`), 10, (i + 1) * DAY);
    const report = await sweepInstanceDisk(deps({ settings: { ...DEFAULT_DISK_REAPER_SETTINGS, dryRun: true } }));
    expect(report.dryRun).toBe(true);
    expect(Object.fromEntries(Object.entries(report.categories).map(([k, v]) => [k, [v.candidates, v.bytes, v.freedBytes]]))).toEqual({
      tmp: [1, 100, 0],
      isolatedAttempts: [1, 50, 0],
      runLogs: [1, 200, 0],
      backups: [2, 20, 0],
    });
    expect(await exists(path.join(runLogRoot, COMPANY, "a", "old.ndjson"))).toBe(true);
    expect(await fs.readdir(tmpRoot)).toHaveLength(1);
    expect(await fs.readdir(backupDir)).toHaveLength(9);
    const text = formatDiskReaperReport(report);
    expect(text).toContain("dry run");
    expect(text).toMatch(/run logs.*200 B/i);
    expect(text).toContain(path.join(tmpRoot, "paperclip-ssh-key-old001"));
  });

  it("reports bytes freed per category on a real run", async () => {
    await put(path.join(runLogRoot, COMPANY, "a", "old.ndjson"), 2048, 20 * DAY);
    const text = formatDiskReaperReport(await sweepInstanceDisk(deps()));
    expect(text).toContain("freed");
    expect(text).toMatch(/run logs.*2\.0 KiB/i);
  });

  it("does nothing when disabled", async () => {
    await put(path.join(runLogRoot, COMPANY, "a", "old.ndjson"), 200, 20 * DAY);
    const report = await sweepInstanceDisk(deps({ settings: { ...DEFAULT_DISK_REAPER_SETTINGS, enabled: false, dryRun: false } }));
    expect(report.categories.runLogs.candidates).toBe(0);
    expect(await exists(path.join(runLogRoot, COMPANY, "a", "old.ndjson"))).toBe(true);
  });
});

describe("disk pressure alert", () => {
  const consumers = [{ path: "/data/backups", bytes: 15e9 }, { path: "/data/run-logs", bytes: 3.6e9 }];

  it("posts a card with the top consumers once use passes the threshold", async () => {
    const post = vi.fn(async () => "posted" as const);
    const result = await postDiskPressureAlert({
      settings: DEFAULT_DISK_REAPER_SETTINGS, usedPercent: 86, mountPath: "/data", consumers, post,
    });
    expect(result).toBe("posted");
    expect(post).toHaveBeenCalledTimes(1);
    const card = (post.mock.calls[0] as unknown as [{ title: string; detailsMarkdown: string }])[0];
    expect(card.title).toContain("86%");
    expect(card.detailsMarkdown).toContain("/data/backups");
    expect(card.detailsMarkdown).toContain("14.0 GiB");
  });

  it("stays quiet at or below the threshold", async () => {
    const post = vi.fn(async () => "posted" as const);
    for (const usedPercent of [40, 85]) {
      expect(await postDiskPressureAlert({
        settings: DEFAULT_DISK_REAPER_SETTINGS, usedPercent, mountPath: "/data", consumers, post,
      })).toBe("below_threshold");
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("honours the instance threshold", async () => {
    const post = vi.fn(async () => "pending_exists" as const);
    expect(await postDiskPressureAlert({
      settings: { ...DEFAULT_DISK_REAPER_SETTINGS, diskAlertPercent: 50 }, usedPercent: 60, mountPath: "/data", consumers, post,
    })).toBe("pending_exists");
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe("instance settings", () => {
  it("defaults to 24 h, 14 days, 7 dumps and 85%, and a stored partial overrides only its fields", () => {
    expect(resolveDiskReaperSettings(undefined)).toMatchObject({ idleHours: 24, runLogRetentionDays: 14, backupKeepCount: 7, diskAlertPercent: 85 });
    expect(resolveDiskReaperSettings({ dryRun: false, idleHours: 6 })).toMatchObject({ dryRun: false, idleHours: 6, backupKeepCount: 7 });
  });

  it("accepts a partial patch and rejects values that would disable the keep guards", () => {
    expect(patchInstanceGeneralSettingsSchema.safeParse({ diskReaper: { dryRun: false } }).success).toBe(true);
    expect(patchInstanceGeneralSettingsSchema.safeParse({ diskReaper: { backupKeepCount: 0 } }).success).toBe(false);
    expect(patchInstanceGeneralSettingsSchema.safeParse({ diskReaper: { idleHours: 0 } }).success).toBe(false);
    expect(patchInstanceGeneralSettingsSchema.safeParse({ diskReaper: { unknown: 1 } }).success).toBe(false);
  });
});
