import { chmod, mkdir, mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => vi.fn(),
  resolveClaudeExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

describe("claude_local mounted skills under a managed AI connection", () => {
  let rootDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-managed-skills-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(rootDir, "paperclip-home"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await chmod(path.join(rootDir, "sources"), 0o755).catch(() => undefined);
    await rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
  });

  async function makeSkill(name: string) {
    const source = path.join(rootDir, "sources", name);
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), `# ${name}\n`);
    // Same modes as the server's runtime skill cache: files 0o444, folders 0o555.
    await chmod(path.join(source, "SKILL.md"), 0o444);
    await chmod(source, 0o555);
    return { key: name, runtimeName: name, source };
  }

  async function run(input: { managed: boolean; configDir: string; skills: Array<{ key: string; runtimeName: string; source: string }> }) {
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    await execute({
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1", name: "Claude Coder", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        engine: "cli",
        cwd: workspaceDir,
        env: { CLAUDE_CONFIG_DIR: input.configDir },
        paperclipRuntimeSkills: input.skills,
        paperclipSkillSync: { desiredSkills: input.skills.map((skill) => skill.key) },
        ...(input.managed ? { managedAiConnection: { provider: "anthropic" } } : {}),
      },
      context: {},
      onLog: vi.fn(async () => {}),
    } as never);
    const calls = runAdapterExecutionTargetProcess.mock.calls as unknown as Array<[string, null, string, string[]]>;
    return calls.at(-1)![3];
  }

  it("copies the mounted skills into the user-scope config dir and drops stale ones", async () => {
    const configDir = path.join(rootDir, "managed-home", "provider");
    await mkdir(path.join(configDir, "skills", "removed-skill"), { recursive: true });
    const rules = await makeSkill("openastro-rules");
    const args = await run({ managed: true, configDir, skills: [rules] });
    expect(args).toContain("user");
    expect(await readFile(path.join(configDir, "skills", "openastro-rules", "SKILL.md"), "utf8")).toBe("# openastro-rules\n");
    expect(await readdir(path.join(configDir, "skills"))).toEqual(["openastro-rules"]);
  });

  it("does not touch the config dir without a managed connection", async () => {
    const configDir = path.join(rootDir, "plain-config");
    await mkdir(configDir, { recursive: true });
    const args = await run({ managed: false, configDir, skills: [await makeSkill("paperclip")] });
    expect(args).not.toContain("--setting-sources");
    expect(await readdir(configDir)).toEqual([]);
  });

  it("keeps one agent's skills out of another agent's config dir", async () => {
    const dirA = path.join(rootDir, "home-a", "provider");
    const dirB = path.join(rootDir, "home-b", "provider");
    await run({ managed: true, configDir: dirA, skills: [await makeSkill("only-for-a")] });
    await run({ managed: true, configDir: dirB, skills: [await makeSkill("only-for-b")] });
    expect(await readdir(path.join(dirB, "skills"))).toEqual(["only-for-b"]);
    expect(await readdir(path.join(dirA, "skills"))).toEqual(["only-for-a"]);
  });

  it("leaves a config dir that can be removed and re-run when the sources are read-only", async () => {
    const configDir = path.join(rootDir, "ro-home", "provider");
    const first = await makeSkill("first-skill");
    await run({ managed: true, configDir, skills: [first] });
    const second = await makeSkill("second-skill");
    await run({ managed: true, configDir, skills: [second] });
    expect(await readdir(path.join(configDir, "skills"))).toEqual(["second-skill"]);
    await expect(rm(path.dirname(configDir), { recursive: true, force: true })).resolves.toBeUndefined();
  });
});
