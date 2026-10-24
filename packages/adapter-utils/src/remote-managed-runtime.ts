import path from "node:path";
import { GIT_ARCHIVE_EXCLUDES, PROJECT_REPOSITORIES_DIR, sshImportedRefForRun } from "./git-workspace-sync.js";
import {
  type SshRemoteExecutionSpec,
  prepareWorkspaceForSshExecution,
  runSshCommand,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
} from "./ssh.js";
import {
  mergeExcludes,
  referencedSourceIgnoreExcludeEntries,
  type SandboxAdditionalSource,
  type SandboxManagedRuntimeAssetRestoreContext,
} from "./sandbox-managed-runtime.js";
import { captureDirectorySnapshot, type DirectorySnapshot } from "./workspace-restore-merge.js";
import type { RuntimeProgressSink } from "./runtime-progress.js";

// The fixed heavy-directory excludes every referenced project drops,
// regardless of its ignore resolution. A `git`-resolved project additionally
// drops its own resolved ignored paths (see `referencedSourceIgnoreExcludeEntries`
// and the per-project merge below); an `other` project keeps only this set.
const REMOTE_ADDITIONAL_SOURCE_HEAVY_DIR_EXCLUDES = [
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".git",
].flatMap((entry) => [entry, `${entry}/*`, `*/${entry}`, `*/${entry}/*`]);

export interface RemoteManagedRuntimeAsset {
  key: string;
  localDir: string;
  followSymlinks?: boolean;
  exclude?: string[];
  restore?: (ctx: SandboxManagedRuntimeAssetRestoreContext) => Promise<void>;
}

export interface PreparedRemoteManagedRuntime {
  spec: SshRemoteExecutionSpec;
  workspaceLocalDir: string;
  workspaceRemoteDir: string;
  runtimeRootDir: string;
  assetDirs: Record<string, string>;
  /**
   * Remote directory of each additional (referenced) project that staged
   * successfully, keyed by `projectId`. A project whose staging failed is
   * absent (per-project failure isolation).
   */
  additionalSourceDirs: Record<string, string>;
  restoreWorkspace(onProgress?: RuntimeProgressSink): Promise<void>;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function readRemoteFile(spec: SshRemoteExecutionSpec, remotePath: string): Promise<Buffer> {
  const result = await runSshCommand(spec, `base64 < ${shellQuote(remotePath)}`, {
    maxBuffer: 1024 * 1024,
  });
  return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
}

export function buildRemoteExecutionSessionIdentity(spec: SshRemoteExecutionSpec | null) {
  if (!spec) return null;
  return {
    transport: "ssh",
    host: spec.host,
    port: spec.port,
    username: spec.username,
    remoteCwd: spec.remoteCwd,
  } as const;
}

export function remoteExecutionSessionMatches(saved: unknown, current: SshRemoteExecutionSpec | null): boolean {
  const currentIdentity = buildRemoteExecutionSessionIdentity(current);
  if (!currentIdentity) return false;

  const parsedSaved = asObject(saved);
  return (
    asString(parsedSaved.transport) === currentIdentity.transport &&
    asString(parsedSaved.host) === currentIdentity.host &&
    asNumber(parsedSaved.port) === currentIdentity.port &&
    asString(parsedSaved.username) === currentIdentity.username &&
    asString(parsedSaved.remoteCwd) === currentIdentity.remoteCwd
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STALE_LOCK_GRACE_MS = 30 * 60 * 1000;

interface StableWorkspaceLock {
  lockDir: string;
  acquired: boolean;
}

// `mkdir` is the atomic lock; the owner file lets another run tell a live holder from a dead one.
async function tryMkdirLock(spec: SshRemoteExecutionSpec, lockDir: string, runId: string): Promise<{ acquired: boolean; owner: string }> {
  const result = await runSshCommand(
    spec,
    `mkdir -p ${shellQuote(path.posix.dirname(lockDir))} && if mkdir ${shellQuote(lockDir)} 2>/dev/null; then ` +
      `printf 'runId=%s\nstartedAt=%s\n' ${shellQuote(runId)} ${Date.now()} > ${shellQuote(`${lockDir}/owner`)}; echo ACQUIRED; ` +
      `else echo BUSY; cat ${shellQuote(`${lockDir}/owner`)} 2>/dev/null; ` +
      `echo "mtime=$(stat -c %Y ${shellQuote(lockDir)} 2>/dev/null || stat -f %m ${shellQuote(lockDir)} 2>/dev/null)"; echo "now=$(date +%s)"; fi`,
  );
  const lines = result.stdout.split("\n").map((line) => line.trim());
  if (lines[0] === "ACQUIRED") return { acquired: true, owner: "" };
  return { acquired: false, owner: result.stdout };
}

async function acquireStableWorkspaceLock(input: {
  spec: SshRemoteExecutionSpec;
  baseDir: string;
  executionWorkspaceId: string;
  runId: string;
  timeoutSec?: number;
  onProgress?: RuntimeProgressSink;
}): Promise<StableWorkspaceLock> {
  const lockDir = path.posix.join(input.baseDir, ".paperclip-runtime", "workspaces", input.executionWorkspaceId, "lock");
  const first = await tryMkdirLock(input.spec, lockDir, input.runId);
  if (first.acquired) return { lockDir, acquired: true };

  const field = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(first.owner)?.[1]?.trim() ?? "";
  const ownerRunId = field("runId");
  const startedAt = Number(field("startedAt"));
  const mtime = Number(field("mtime"));
  const now = Number(field("now"));
  let stale: boolean;
  if (ownerRunId && input.spec.isRunActive) {
    stale = !(await input.spec.isRunActive(ownerRunId).catch(() => true));
  } else {
    const timeoutMs = input.timeoutSec && input.timeoutSec > 0 ? input.timeoutSec * 1000 : 0;
    const ageMs = Number.isFinite(startedAt) && startedAt > 0
      ? Date.now() - startedAt
      : Number.isFinite(mtime) && Number.isFinite(now) && mtime > 0 ? (now - mtime) * 1000 : 0;
    stale = ageMs > timeoutMs + STALE_LOCK_GRACE_MS;
  }
  if (stale) {
    await runSshCommand(input.spec, `rm -rf ${shellQuote(lockDir)}`);
    const retaken = await tryMkdirLock(input.spec, lockDir, input.runId);
    if (retaken.acquired) return { lockDir, acquired: true };
  }
  await input.onProgress?.(
    `[paperclip] stable remote folder busy (owner ${(ownerRunId || "unknown").replace(/[^A-Za-z0-9_-]/g, "?")}); using per-run folder\n`,
  );
  return { lockDir, acquired: false };
}

// Only the owner removes the lock, so a late finally never frees a lock another run took over.
async function releaseStableWorkspaceLock(spec: SshRemoteExecutionSpec, lockDir: string, runId: string): Promise<void> {
  await runSshCommand(
    spec,
    `grep -qx ${shellQuote(`runId=${runId}`)} ${shellQuote(`${lockDir}/owner`)} 2>/dev/null && rm -rf ${shellQuote(lockDir)}; true`,
  );
}

export async function prepareRemoteManagedRuntime(input: {
  spec: SshRemoteExecutionSpec;
  runId: string;
  adapterKey: string;
  workspaceLocalDir: string;
  workspaceRemoteDir?: string;
  /** Execution workspace id; keys the stable remote folder when `spec.remoteWorkspaceKey` is "execution_workspace". */
  executionWorkspaceId?: string | null;
  /** Adapter timeout; a lock older than this plus 30 minutes is stale when no `spec.isRunActive` exists. */
  timeoutSec?: number;
  syncWorkspace?: boolean;
  workspaceFileMode?: "all";
  workspaceExclude?: string[];
  assets?: RemoteManagedRuntimeAsset[];
  /** Referenced (additional) projects to stage as plain, read-only trees. */
  additionalSources?: SandboxAdditionalSource[];
  // Upload progress sink. Threaded for the byte-counting transport rewrite; the
  // child task wires it into the workspace/asset transfers.
  onProgress?: RuntimeProgressSink;
}): Promise<PreparedRemoteManagedRuntime> {
  const baseWorkspaceRemoteDir = input.workspaceRemoteDir ?? input.spec.remoteCwd;
  const syncWorkspace = input.syncWorkspace !== false;
  const stableId =
    syncWorkspace && input.spec.remoteWorkspaceKey === "execution_workspace" && input.executionWorkspaceId &&
    UUID_PATTERN.test(input.executionWorkspaceId)
      ? input.executionWorkspaceId
      : null;
  const stableLock = stableId
    ? await acquireStableWorkspaceLock({
        spec: input.spec,
        baseDir: baseWorkspaceRemoteDir,
        executionWorkspaceId: stableId,
        runId: input.runId,
        timeoutSec: input.timeoutSec,
        onProgress: input.onProgress,
      })
    : null;
  const releaseStableLock = async () => {
    if (stableLock?.acquired) await releaseStableWorkspaceLock(input.spec, stableLock.lockDir, input.runId).catch(() => undefined);
  };
  const stableWorkspaceDir = stableLock?.acquired
    ? path.posix.join(baseWorkspaceRemoteDir, ".paperclip-runtime", "workspaces", stableId!, "workspace")
    : null;
  const workspaceRemoteDir = !syncWorkspace
    ? baseWorkspaceRemoteDir
    : stableWorkspaceDir ??
      path.posix.join(baseWorkspaceRemoteDir, ".paperclip-runtime", "runs", input.runId, "workspace");
  // A stable workspace folder is shared across runs, so runtime assets stay per run beside it.
  const runtimeRootDir = stableWorkspaceDir
    ? path.posix.join(baseWorkspaceRemoteDir, ".paperclip-runtime", "runs", input.runId, "runtime", input.adapterKey)
    : path.posix.join(workspaceRemoteDir, ".paperclip-runtime", input.adapterKey);
  try {
    return await prepareLockedRemoteManagedRuntime();
  } catch (error) {
    await releaseStableLock();
    throw error;
  }

  async function prepareLockedRemoteManagedRuntime(): Promise<PreparedRemoteManagedRuntime> {
  // Named after the run so a reaper can land this run's import, and only it.
  const importedRef = sshImportedRefForRun(input.runId) ?? undefined;

  const preparedWorkspace = syncWorkspace
    ? await prepareWorkspaceForSshExecution({
        spec: input.spec,
        localDir: input.workspaceLocalDir,
        remoteDir: workspaceRemoteDir,
        onProgress: input.onProgress,
        workspaceFileMode: input.workspaceFileMode,
        workspaceExclude: input.workspaceExclude,
      })
    : null;
  const projectRepositories = preparedWorkspace?.repositories ?? [];
  const baselineSnapshot = preparedWorkspace
    ? await captureDirectorySnapshot(input.workspaceLocalDir, {
        exclude: preparedWorkspace.gitBacked
          // tar excludes .git at any depth, so nested checkouts (.paperclip-repositories/*/.git)
          // never come back from the remote; keep them out of the baseline or the merge deletes them.
          ? [
              ...GIT_ARCHIVE_EXCLUDES,
              "*/.git",
              ".paperclip-runtime",
              ...(projectRepositories.length > 0 ? [PROJECT_REPOSITORIES_DIR] : []),
            ]
          : [".paperclip-runtime", ...(input.workspaceFileMode === "all" ? input.workspaceExclude ?? [] : [])],
      })
    : null;
  const repositoryBaselines: Array<{ path: string; baselineSnapshot: DirectorySnapshot }> = [];
  for (const repository of projectRepositories) {
    repositoryBaselines.push({
      path: repository,
      baselineSnapshot: await captureDirectorySnapshot(path.join(input.workspaceLocalDir, repository), {
        exclude: [...GIT_ARCHIVE_EXCLUDES, ".paperclip-runtime"],
      }),
    });
  }

  const assetDirs: Record<string, string> = {};
  try {
    for (const asset of input.assets ?? []) {
      const remoteDir = path.posix.join(runtimeRootDir, asset.key);
      assetDirs[asset.key] = remoteDir;
      await syncDirectoryToSsh({
        spec: input.spec,
        localDir: asset.localDir,
        remoteDir,
        followSymlinks: asset.followSymlinks,
        exclude: asset.exclude,
        onProgress: input.onProgress,
        progressLabel: asset.key,
      });
    }
  } catch (error) {
    if (preparedWorkspace && baselineSnapshot) {
      await restoreWorkspaceFromSshExecution({
        spec: input.spec,
        localDir: input.workspaceLocalDir,
        remoteDir: workspaceRemoteDir,
        baselineSnapshot,
        restoreGitHistory: preparedWorkspace.gitBacked,
        importedRef,
        onProgress: input.onProgress,
        repositories: repositoryBaselines,
      });
    }
    throw error;
  }

  // Stage each referenced (additional) project as a plain, read-only tree in its
  // OWN isolated remote directory (`project-<projectId>`). Additional sources
  // never get the anchor's git-history/overlay semantics. Per-project failure
  // isolation: one project's failure logs a warning and is skipped; the run and
  // the other projects continue (no workspace restore, unlike an asset failure).
  const additionalSourceDirs: Record<string, string> = {};
  for (const source of input.additionalSources ?? []) {
    const { localPath, projectId, ignoreResolution } = source;
    try {
      if (!path.posix.isAbsolute(localPath)) {
        throw new Error(`additional source localPath is not an absolute path: ${localPath}`);
      }
      if (
        projectId.length === 0 ||
        projectId.includes("/") ||
        projectId.includes("\\") ||
        projectId.includes("..")
      ) {
        throw new Error(`additional source projectId is not a simple path segment: ${projectId}`);
      }
      // Fail closed: a project whose ignore resolution failed is not staged at
      // all — the existing per-project skip-and-warn path below handles it.
      if (ignoreResolution.kind === "failed") {
        throw new Error(`referenced project ignore resolution failed: ${ignoreResolution.reason}`);
      }
      const remoteDir = path.posix.join(runtimeRootDir, `project-${projectId}`);
      const exclude = mergeExcludes(
        REMOTE_ADDITIONAL_SOURCE_HEAVY_DIR_EXCLUDES,
        referencedSourceIgnoreExcludeEntries(ignoreResolution),
      );
      await syncDirectoryToSsh({
        spec: input.spec,
        localDir: localPath,
        remoteDir,
        exclude,
        onProgress: input.onProgress,
        progressLabel: `project-${projectId}`,
      });
      additionalSourceDirs[projectId] = remoteDir;
    } catch (error) {
      console.warn(
        `[paperclip] Failed to stage referenced project ${projectId}; skipping it. ${String(error)}`,
      );
    }
  }

  return {
    spec: input.spec,
    workspaceLocalDir: input.workspaceLocalDir,
    workspaceRemoteDir,
    runtimeRootDir,
    assetDirs,
    additionalSourceDirs,
    restoreWorkspace: async (onProgress?: RuntimeProgressSink) => {
      try {
      if (preparedWorkspace && baselineSnapshot) {
        await restoreWorkspaceFromSshExecution({
          spec: input.spec,
          localDir: input.workspaceLocalDir,
          remoteDir: workspaceRemoteDir,
          baselineSnapshot,
          restoreGitHistory: preparedWorkspace.gitBacked,
          importedRef,
          onProgress,
          repositories: repositoryBaselines,
        });
      }
      for (const asset of input.assets ?? []) {
        if (!asset.restore) continue;
        await asset.restore({
          assetDir: path.posix.join(runtimeRootDir, asset.key),
          readFile: (remotePath) => readRemoteFile(input.spec, remotePath),
        });
      }
      } finally {
        await releaseStableLock();
      }
    },
  };
  }
}
