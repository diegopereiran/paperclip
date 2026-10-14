import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveLedgerCostStatus } from "../services/heartbeat.js";
import { execute } from "@paperclipai/adapter-claude-local/server";

const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const STALE_SESSION_ID = "11111111-1111-4111-8111-111111111111";

async function writeStreamClaudeCommand(
  commandPath: string,
  options: { withResult: boolean; hang?: boolean; staleResume?: boolean },
): Promise<void> {
  const script = `#!/usr/bin/env node
require("node:fs").readFileSync(0, "utf8");
const emit = (event) => console.log(JSON.stringify(event));
${options.staleResume
    ? `if (process.argv.includes("--resume")) {
  emit({ type: "result", subtype: "error", is_error: true, session_id: ${JSON.stringify(STALE_SESSION_ID)}, result: "No conversation found with session id ${STALE_SESSION_ID}", errors: ["No conversation found with session id ${STALE_SESSION_ID}"] });
  process.exit(1);
}`
    : ""}
emit({ type: "system", subtype: "init", session_id: ${JSON.stringify(SESSION_ID)}, model: "claude-sonnet" });
emit({ type: "assistant", session_id: ${JSON.stringify(SESSION_ID)}, message: { id: "msg-1", content: [{ type: "text", text: "first" }], usage: { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 5 } } });
emit({ type: "assistant", session_id: ${JSON.stringify(SESSION_ID)}, message: { id: "msg-2", content: [{ type: "text", text: "second" }], usage: { input_tokens: 20, cache_read_input_tokens: 0, output_tokens: 7 } } });
${options.withResult
    ? `emit({ type: "result", subtype: "success", session_id: ${JSON.stringify(SESSION_ID)}, result: "done", usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 40 } });
process.exit(0);`
    : options.hang
      ? "setInterval(() => {}, 1000);"
      : "process.exit(143);"}
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function runStream(withResult: boolean, options: { hang?: boolean; staleResume?: boolean } = {}) {
  const onUsage = vi.fn();
  const logs: string[] = [];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-cut-stream-"));
  const workspace = path.join(root, "workspace");
  const commandPath = path.join(root, "claude");
  await fs.mkdir(workspace, { recursive: true });
  await writeStreamClaudeCommand(commandPath, { withResult, hang: options.hang, staleResume: options.staleResume });
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const result = await execute({
      runId: "run-cut-stream",
      agent: { id: "agent-1", companyId: "company-1", name: "Claude", adapterType: "claude_local", adapterConfig: {} },
      runtime: {
        sessionId: options.staleResume ? STALE_SESSION_ID : null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { engine: "cli", command: commandPath, cwd: workspace, ...(options.hang ? { timeoutSec: 2, graceSec: 1 } : {}) },
      context: {},
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
      onUsage,
    });
    return { result, onUsage, logs: logs.join("") };
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
    // The adapter reports no price; the ledger turns that into "unpriced".
    expect(result.costUsd ?? null).toBeNull();
    expect(result.clearSession).toBeFalsy();
    expect(resolveLedgerCostStatus({ costUsd: result.costUsd, inputTokens: 30, cachedInputTokens: 0, outputTokens: 12 })).toBe("unpriced");
  });

  it("keeps the session id and partial usage when the run times out before result", async () => {
    const { result } = await runStream(false, { hang: true });
    expect(result.timedOut).toBe(true);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.sessionParams).toMatchObject({ sessionId: SESSION_ID });
    expect(result.sessionDisplayId).toBe(SESSION_ID);
    expect(result.usage).toEqual({ inputTokens: 30, cachedInputTokens: 0, outputTokens: 12 });
    expect(result.usageComplete).toBe(false);
    expect(result.clearSession).toBeFalsy();
  });

  it("keeps the new session when the fresh-session retry is cut before result", async () => {
    const { result, logs } = await runStream(false, { staleResume: true });
    expect(logs).toContain(`Claude resume session "${STALE_SESSION_ID}" is unavailable; retrying with a fresh session.`);
    expect(result.exitCode).toBe(143);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.sessionParams).toMatchObject({ sessionId: SESSION_ID });
    expect(result.usage).toEqual({ inputTokens: 30, cachedInputTokens: 0, outputTokens: 12 });
    expect(result.clearSession).toBeFalsy();
  });

  it("keeps the new session when the fresh-session retry times out before result", async () => {
    const { result, logs } = await runStream(false, { hang: true, staleResume: true });
    expect(logs).toContain(`Claude resume session "${STALE_SESSION_ID}" is unavailable; retrying with a fresh session.`);
    expect(result.timedOut).toBe(true);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.sessionParams).toMatchObject({ sessionId: SESSION_ID });
    expect(result.usage).toEqual({ inputTokens: 30, cachedInputTokens: 0, outputTokens: 12 });
    expect(result.clearSession).toBeFalsy();
  });

  it("keeps the session id and the result usage when the stream ends with result", async () => {
    const { result, onUsage } = await runStream(true);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.sessionParams).toMatchObject({ sessionId: SESSION_ID });
    // The result event's usage wins over the sum of the streamed messages (30/12).
    expect(result.usage).toEqual({ inputTokens: 100, cachedInputTokens: 0, outputTokens: 40 });
    expect(result.usageComplete).toBe(true);
    expect(onUsage.mock.calls.at(-1)![0]).toMatchObject({ complete: true });
  });
});
