import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runWithAgentEnvPolicy } from "@paperclipai/adapter-utils/agent-env-policy";
import { execute as executeClaude } from "@paperclipai/adapter-claude-local/server";
import { execute as executeCodex } from "@paperclipai/adapter-codex-local/server";

const SERVER_SECRETS = {
  DATABASE_URL: "postgres://server-secret",
  BETTER_AUTH_SECRET: "better-auth-server-secret",
  FOO_SECRET: "foo-server-secret",
};

const FAKE_COMMAND = `#!/usr/bin/env node
const fs = require("node:fs");
fs.readFileSync(0, "utf8");
fs.writeFileSync(process.env.PAPERCLIP_TEST_CAPTURE_PATH, JSON.stringify(process.env), "utf8");
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111", model: "m" }));
console.log(JSON.stringify({ type: "result", session_id: "11111111-1111-4111-8111-111111111111", result: "ok", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }));
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`;

type Harness = {
  adapterType: "claude_local" | "codex_local";
  run: typeof executeClaude;
  binary: string;
};

const HARNESSES: Harness[] = [
  { adapterType: "claude_local", run: executeClaude, binary: "claude" },
  { adapterType: "codex_local", run: executeCodex, binary: "codex" },
];

describe.each(HARNESSES)("$adapterType environment allow-list", ({ adapterType, run, binary }) => {
  let root: string;
  let workspace: string;
  let commandPath: string;
  let capturePath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-env-allowlist-${binary}-`));
    workspace = path.join(root, "workspace");
    commandPath = path.join(root, binary);
    capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, FAKE_COMMAND, "utf8");
    await fs.chmod(commandPath, 0o755);
    vi.stubEnv("HOME", root);
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip-home"));
    for (const [key, value] of Object.entries(SERVER_SECRETS)) vi.stubEnv(key, value);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function launch() {
    let loggedEnv: Record<string, string> = {};
    const result = await run({
      runId: "run-env-allowlist",
      agent: { id: "agent-1", companyId: "company-1", name: "Agent", adapterType, adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        engine: "cli",
        command: commandPath,
        cwd: workspace,
        env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath, CONFIGURED_BY_AGENT: "agent-config-value" },
      },
      context: {},
      authToken: "run-jwt-token",
      onLog: async () => {},
      onMeta: async (meta) => {
        loggedEnv = meta.env ?? {};
      },
    });
    expect(result.exitCode).toBe(0);
    const childEnv = JSON.parse(await fs.readFile(capturePath, "utf8")) as Record<string, string>;
    return { childEnv, loggedEnv };
  }

  it("keeps server-only variables out of the child and out of loggedEnv", async () => {
    const { childEnv, loggedEnv } = await launch();
    for (const key of Object.keys(SERVER_SECRETS)) {
      expect(childEnv).not.toHaveProperty(key);
      expect(loggedEnv).not.toHaveProperty(key);
    }
    expect(JSON.stringify(loggedEnv)).not.toContain("server-secret");
    expect(childEnv.PATH).toBeTruthy();
    expect(childEnv.HOME).toBeTruthy();
    expect(childEnv.PAPERCLIP_API_KEY).toBe("run-jwt-token");
    expect(childEnv.PAPERCLIP_RUN_ID).toBe("run-env-allowlist");
    expect(childEnv.CONFIGURED_BY_AGENT).toBe("agent-config-value");
  });

  it("passes an inheritEnv entry through and nothing else", async () => {
    const { childEnv, loggedEnv } = await runWithAgentEnvPolicy({ inheritEnv: ["FOO_*"] }, launch);
    expect(childEnv.FOO_SECRET).toBe(SERVER_SECRETS.FOO_SECRET);
    expect(childEnv).not.toHaveProperty("DATABASE_URL");
    expect(childEnv).not.toHaveProperty("BETTER_AUTH_SECRET");
    expect(loggedEnv).not.toHaveProperty("FOO_SECRET");
  });

  it("applies the default with no policy set (a company created later needs no setup)", async () => {
    const { childEnv } = await runWithAgentEnvPolicy({}, launch);
    expect(childEnv).not.toHaveProperty("DATABASE_URL");
    expect(childEnv).not.toHaveProperty("FOO_SECRET");
  });
});

describe("adapter sources no longer spread the server environment", () => {
  const ADAPTER_SOURCES = [
    "packages/adapters/claude-local/src/server/execute.ts",
    "packages/adapters/codex-local/src/server/execute.ts",
  ];

  it.each(ADAPTER_SOURCES)("%s has no process.env spread outside the documented seed read", async (relative) => {
    const source = await fs.readFile(path.resolve(__dirname, "../../..", relative), "utf8");
    const lines = source.split("\n");
    const spreadAt = lines.flatMap((line, index) => (/\.\.\.\s*process\.env\b/.test(line) ? [index] : []));
    const allowed = relative.includes("codex-local") ? 1 : 0;
    expect(spreadAt.length).toBe(allowed);
    if (allowed) expect(lines.slice(Math.max(0, spreadAt[0] - 2), spreadAt[0] + 1).join("\n")).toContain("seedEnv");
  });
});
