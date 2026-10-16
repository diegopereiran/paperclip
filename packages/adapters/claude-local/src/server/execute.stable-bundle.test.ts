import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("claude_local stable prompt bundle", () => {
  const cleanupDirs: string[] = [];
  const instructionsBody = "# Agent\nBe useful.\n";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function run(opts: { runId: string; resumeSessionId?: string; promptBundleKey?: string }) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "claude-stable-bundle-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const runDir = path.join(rootDir, opts.runId);
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(runDir, { recursive: true });
    const instructionsFilePath = path.join(runDir, "AGENTS.md");
    await writeFile(instructionsFilePath, instructionsBody);
    await execute({
      runId: opts.runId,
      agent: { id: "agent-1", companyId: "company-1", name: "Claude Coder", adapterType: "claude_local", adapterConfig: {} },
      runtime: {
        sessionId: opts.resumeSessionId ?? null,
        sessionParams: opts.resumeSessionId
          ? { sessionId: opts.resumeSessionId, cwd: workspaceDir, promptBundleKey: opts.promptBundleKey }
          : null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { engine: "cli", cwd: workspaceDir, instructionsFilePath },
      context: {},
      onLog: vi.fn(async () => {}),
    } as never);
    const calls = runAdapterExecutionTargetProcess.mock.calls as unknown as Array<
      [string, null, string, string[], { stdin?: string }]
    >;
    const call = calls.at(-1)!;
    const args = call[3];
    const flag = (name: string) => {
      const i = args.indexOf(name);
      return i < 0 ? undefined : args[i + 1];
    };
    const systemPromptFile = flag("--append-system-prompt-file");
    return {
      instructionsFilePath,
      args,
      addDir: flag("--add-dir"),
      prompt: call[4]?.stdin ?? "",
      systemPrompt: systemPromptFile ? await readFile(systemPromptFile, "utf-8") : null,
    };
  }

  it("uses the same bundle for byte-identical instructions under different run dirs", async () => {
    const first = await run({ runId: "run-aaaa" });
    const second = await run({ runId: "run-bbbb" });
    expect(first.instructionsFilePath).not.toBe(second.instructionsFilePath);
    expect(second.addDir).toBe(first.addDir);
  });

  it("puts the path directive in the prompt, not in the system prompt file", async () => {
    const result = await run({ runId: "run-cccc" });
    const directive = `The above agent instructions were loaded from ${result.instructionsFilePath}.`;
    expect(result.prompt).toContain(directive);
    expect(result.systemPrompt).toContain("Be useful.");
    expect(result.systemPrompt).not.toContain("were loaded from");
    expect(result.systemPrompt).not.toContain(result.instructionsFilePath);
  });

  it("keeps the directive in the prompt on a resumed session", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const first = await run({ runId: "run-dddd" });
    const key = path.basename(first.addDir!);
    const result = await run({ runId: "run-eeee", resumeSessionId: sessionId, promptBundleKey: key });
    expect(result.args).toContain("--resume");
    expect(result.prompt).toContain(`were loaded from ${result.instructionsFilePath}.`);
  });
});
