import { beforeEach, describe, expect, it, vi } from "vitest";

const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
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

import { runClaudeLogin } from "./execute.js";

function buildProc(stdout: string, stderr: string) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr,
    pid: 321,
    startedAt: new Date().toISOString(),
  };
}

function buildInput() {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    config: { engine: "cli" },
    context: {},
  };
}

describe("runClaudeLogin loginUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the login URL the CLI prints on stdout", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(
      buildProc("Browser did not open? Use the url below to sign in:\n\nhttps://claude.ai/login\n", ""),
    );

    const result = await runClaudeLogin(buildInput() as never);

    expect(result.loginUrl).toBe("https://claude.ai/login");
  });

  it("reads the login URL the CLI prints on stderr", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(buildProc("", "Open https://claude.ai/login to sign in\n"));

    const result = await runClaudeLogin(buildInput() as never);

    expect(result.loginUrl).toBe("https://claude.ai/login");
  });
});
