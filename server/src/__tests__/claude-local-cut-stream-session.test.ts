import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-claude-local/server";

const SESSION_ID = "55555555-5555-4555-8555-555555555555";

async function writeStreamClaudeCommand(commandPath: string, options: { withResult: boolean }): Promise<void> {
  const script = `#!/usr/bin/env node
require("node:fs").readFileSync(0, "utf8");
const emit = (event) => console.log(JSON.stringify(event));
emit({ type: "system", subtype: "init", session_id: ${JSON.stringify(SESSION_ID)}, model: "claude-sonnet" });
emit({ type: "assistant", session_id: ${JSON.stringify(SESSION_ID)}, message: { id: "msg-1", content: [{ type: "text", text: "first" }], usage: { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 5 } } });
emit({ type: "assistant", session_id: ${JSON.stringify(SESSION_ID)}, message: { id: "msg-2", content: [{ type: "text", text: "second" }], usage: { input_tokens: 20, cache_read_input_tokens: 0, output_tokens: 7 } } });
${options.withResult
    ? `emit({ type: "result", subtype: "success", session_id: ${JSON.stringify(SESSION_ID)}, result: "done", usage: { input_tokens: 30, cache_read_input_tokens: 0, output_tokens: 12 } });
process.exit(0);`
    : "process.exit(143);"}
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function runStream(withResult: boolean) {
  const onUsage = vi.fn();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-cut-stream-"));
  const workspace = path.join(root, "workspace");
  const commandPath = path.join(root, "claude");
  await fs.mkdir(workspace, { recursive: true });
  await writeStreamClaudeCommand(commandPath, { withResult });
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const result = await execute({
      runId: "run-cut-stream",
      agent: { id: "agent-1", companyId: "company-1", name: "Claude", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { engine: "cli", command: commandPath, cwd: workspace },
      context: {},
      onLog: async () => {},
      onUsage,
    });
    return { result, onUsage };
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("claude execute stream accounting", () => {
  it("keeps the session id and partial incomplete usage when the stream is cut before result", async () => {
    const { result, onUsage } = await runStream(false);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.sessionParams).toMatchObject({ sessionId: SESSION_ID });
    expect(result.usage).toEqual({ inputTokens: 30, cachedInputTokens: 0, outputTokens: 12 });
    expect(result.usageComplete).toBe(false);
    expect(onUsage.mock.calls.at(-1)![0]).toMatchObject({ complete: false, costUsd: null });
    expect(onUsage.mock.calls.at(-1)![0].costStatus).not.toBe("estimated");
    expect(result.costUsd ?? null).toBeNull();
  });

  it("keeps the session id and complete usage when the stream ends with result", async () => {
    const { result, onUsage } = await runStream(true);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.sessionParams).toMatchObject({ sessionId: SESSION_ID });
    expect(result.usage).toEqual({ inputTokens: 30, cachedInputTokens: 0, outputTokens: 12 });
    expect(result.usageComplete).toBe(true);
    expect(onUsage.mock.calls.at(-1)![0]).toMatchObject({ complete: true });
  });
});
