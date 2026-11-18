import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type WorkspaceRescueResult =
  | { status: "clean" }
  | { status: "pushed"; branch: string; sha: string; remote: string };

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Push a workspace's unsaved work to `rescue/<identifier>` on `remote` before
 * the workspace is deleted. A worktree with no dirty files and no commit that
 * is missing from every remote needs no rescue. Dirty and untracked files go
 * into a snapshot commit built on a throwaway index, so the worktree and its
 * branch stay untouched. Throws when the push fails: the caller keeps the
 * workspace.
 */
export async function rescuePushWorkspace(input: {
  worktreePath: string;
  identifier: string;
  remote?: string;
}): Promise<WorkspaceRescueResult> {
  const remote = input.remote ?? "origin";
  const dirty = (await git(input.worktreePath, ["status", "--porcelain", "--untracked-files=all"])).length > 0;
  const unpushed = Number(await git(input.worktreePath, ["rev-list", "--count", "HEAD", "--not", "--remotes"])) > 0;
  if (!dirty && !unpushed) return { status: "clean" };

  let sha = await git(input.worktreePath, ["rev-parse", "HEAD"]);
  if (dirty) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-rescue-"));
    try {
      const env = {
        GIT_INDEX_FILE: path.join(tmp, "index"),
        GIT_AUTHOR_NAME: "Paperclip",
        GIT_AUTHOR_EMAIL: "paperclip@localhost",
        GIT_COMMITTER_NAME: "Paperclip",
        GIT_COMMITTER_EMAIL: "paperclip@localhost",
      };
      await git(input.worktreePath, ["read-tree", "HEAD"], env);
      await git(input.worktreePath, ["add", "-A"], env);
      const tree = await git(input.worktreePath, ["write-tree"], env);
      sha = await git(input.worktreePath, ["commit-tree", tree, "-p", sha, "-m", "Rescue snapshot of unsaved work"], env);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
  const branch = `rescue/${input.identifier.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
  await git(input.worktreePath, ["push", remote, `${sha}:refs/heads/${branch}`]);
  return { status: "pushed", branch, sha, remote };
}
