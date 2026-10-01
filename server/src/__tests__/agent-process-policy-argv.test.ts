import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runWithAgentProcessPolicy } from "@paperclipai/adapter-utils/agent-process-policy";
import { execute as executeClaude } from "@paperclipai/adapter-claude-local/server";
import { execute as executeCodex } from "@paperclipai/adapter-codex-local/server";

const FAKE_COMMAND = `#!/usr/bin/env node
const fs = require("node:fs");
fs.readFileSync(0, "utf8");
fs.writeFileSync(process.env.PAPERCLIP_TEST_CAPTURE_PATH, JSON.stringify(process.argv.slice(2)), "utf8");
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111", model: "m" }));
console.log(JSON.stringify({ type: "result", session_id: "11111111-1111-4111-8111-111111111111", result: "ok", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }));
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`;

const HARNESSES = [
  { adapterType: "claude_local", run: executeClaude, binary: "claude" },
  { adapterType: "codex_local", run: executeCodex, binary: "codex" },
] as const;

describe.each(HARNESSES)("$adapterType spawn argv with the process policy off", ({ adapterType, run, binary }) => {
  let root: string;
  let workspace: string;
  let commandPath: string;
  let capturePath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-process-policy-argv-${binary}-`));
    workspace = path.join(root, "workspace");
    commandPath = path.join(root, binary);
    capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, FAKE_COMMAND, "utf8");
    await fs.chmod(commandPath, 0o755);
    vi.stubEnv("HOME", root);
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip-home"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function launchArgv(): Promise<string[]> {
    const result = await run({
      runId: "run-process-policy-argv",
      agent: { id: "agent-1", companyId: "company-1", name: "Agent", adapterType, adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        engine: "cli",
        command: commandPath,
        cwd: workspace,
        env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
      },
      context: {},
      authToken: "run-jwt-token",
      onLog: async () => {},
      onMeta: async () => {},
    });
    expect(result.exitCode).toBe(0);
    return JSON.parse(await fs.readFile(capturePath, "utf8")) as string[];
  }

  it("is identical with no policy, an empty policy and mode off", async () => {
    const baseline = await launchArgv();
    expect(baseline.length).toBeGreaterThan(0);
    expect(await runWithAgentProcessPolicy({}, launchArgv)).toEqual(baseline);
    expect(
      await runWithAgentProcessPolicy(
        {
          mode: "off",
          filesystem: { scope: "workspace", rw: ["/srv/shared/cache"] },
          network: { scope: "deny" },
          commandWrapper: ["/usr/bin/true"],
        },
        launchArgv,
      ),
    ).toEqual(baseline);
  });
});
