import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GitRemoteAuthProvider } from "./git-credentials.js";

const execFileAsync = promisify(execFile);

const RESCUE_PUSH_TIMEOUT_MS = 60_000;

export type WorkspaceRescueResult =
  | { status: "clean" }
  | { status: "pushed"; branch: string; sha: string; remote: string; tree: string | null };

async function git(
  cwd: string,
  args: string[],
  extra: { env?: NodeJS.ProcessEnv; configArgs?: string[]; timeout?: number; signal?: AbortSignal } = {},
) {
  const { stdout } = await execFileAsync("git", [...(extra.configArgs ?? []), "-C", cwd, ...args], {
    env: { ...process.env, ...extra.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 32 * 1024 * 1024,
    timeout: extra.timeout,
    signal: extra.signal,
  });
  return stdout.trim();
}

const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "Paperclip",
  GIT_AUTHOR_EMAIL: "paperclip@localhost",
  GIT_COMMITTER_NAME: "Paperclip",
  GIT_COMMITTER_EMAIL: "paperclip@localhost",
};

/**
 * Tree of HEAD plus every dirty and untracked (non-ignored) file, built on a
 * throwaway index so the worktree and its branch stay untouched.
 */
export async function snapshotWorkspaceTree(worktreePath: string): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-rescue-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(tmp, "index"), ...SNAPSHOT_IDENTITY };
    await git(worktreePath, ["read-tree", "HEAD"], { env });
    await git(worktreePath, ["add", "-A"], { env });
    return await git(worktreePath, ["write-tree"], { env });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Push a workspace's unsaved work to `rescue/<identifier>` on `remote` before
 * the workspace is deleted. A worktree with no dirty files and no commit that
 * is missing from every remote needs no rescue. Dirty and untracked files go
 * into a snapshot commit (see `snapshotWorkspaceTree`); `tree` is its tree, so
 * the caller can verify the worktree is unchanged before it deletes it. When
 * the branch already exists on the remote (an earlier rescue of the same
 * issue) the push goes to `rescue/<identifier>-<sha7>`; it never forces.
 * The push uses the company's git credentials, never prompts, and ends at the
 * timeout or the signal. Throws when the push fails: the caller keeps the
 * workspace.
 */
export async function rescuePushWorkspace(input: {
  worktreePath: string;
  identifier: string;
  remote?: string;
  resolveGitAuth?: GitRemoteAuthProvider | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<WorkspaceRescueResult> {
  const remote = input.remote ?? "origin";
  const dirty = (await git(input.worktreePath, ["status", "--porcelain", "--untracked-files=all"])).length > 0;
  const unpushed = Number(await git(input.worktreePath, ["rev-list", "--count", "HEAD", "--not", "--remotes"])) > 0;
  if (!dirty && !unpushed) return { status: "clean" };

  let sha = await git(input.worktreePath, ["rev-parse", "HEAD"]);
  let tree: string | null = null;
  if (dirty) {
    tree = await snapshotWorkspaceTree(input.worktreePath);
    sha = await git(input.worktreePath, ["commit-tree", tree, "-p", sha, "-m", "Rescue snapshot of unsaved work"], {
      env: SNAPSHOT_IDENTITY,
    });
  }
  const remoteUrl = await git(input.worktreePath, ["remote", "get-url", remote]);
  const auth = input.resolveGitAuth ? await input.resolveGitAuth(remoteUrl) : null;
  const net = {
    env: auth?.env,
    configArgs: auth?.configArgs,
    timeout: input.timeoutMs ?? RESCUE_PUSH_TIMEOUT_MS,
    signal: input.signal,
  };
  let branch = `rescue/${input.identifier.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
  const existing = await git(input.worktreePath, ["ls-remote", "--heads", remote, `refs/heads/${branch}`], net);
  if (existing.length > 0 && existing.split(/\s+/)[0] !== sha) branch = `${branch}-${sha.slice(0, 7)}`;
  await git(input.worktreePath, ["push", remote, `${sha}:refs/heads/${branch}`], net);
  return { status: "pushed", branch, sha, remote, tree };
}
