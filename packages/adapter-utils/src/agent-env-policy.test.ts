import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_ENV_ALLOWLIST,
  normalizeAgentEnvPatterns,
  runWithAgentEnvPolicy,
  selectInheritedAgentEnv,
} from "./agent-env-policy.js";
import { runChildProcess } from "./server-utils.js";
import { runAdapterExecutionTargetProcess } from "./execution-target.js";
import { finalizeLaunchEnvironment } from "./acpx-engine/execute.js";

const SERVER_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/server",
  LC_ALL: "C.UTF-8",
  ANTHROPIC_API_KEY: "sk-ant-harness",
  DATABASE_URL: "postgres://paperclip:hunter2@127.0.0.1:5432/paperclip",
  BETTER_AUTH_SECRET: "auth-secret",
  FOO_SECRET: "foo-secret",
  EXTRA_TOKEN: "extra-token",
  PAPERCLIP_HOME: "/srv/paperclip",
  PAPERCLIP_API_KEY: "server-level-key",
};

const DROPPED = ["DATABASE_URL", "BETTER_AUTH_SECRET", "FOO_SECRET"] as const;
const PRINT_ENV = "process.stdout.write(JSON.stringify(process.env))";

async function childEnvViaRunChildProcess(env: Record<string, string>) {
  let stdout = "";
  const result = await runChildProcess("run-1", process.execPath, ["-e", PRINT_ENV], {
    cwd: process.cwd(),
    env,
    timeoutSec: 20,
    graceSec: 1,
    onLog: async (stream, chunk) => {
      if (stream === "stdout") stdout += chunk;
    },
  });
  expect(result.exitCode).toBe(0);
  return JSON.parse(stdout) as Record<string, string>;
}

async function childEnvViaExecutionTarget(env: Record<string, string>) {
  let stdout = "";
  const result = await runAdapterExecutionTargetProcess("run-1", null, process.execPath, ["-e", PRINT_ENV], {
    cwd: process.cwd(),
    env,
    timeoutSec: 20,
    graceSec: 1,
    onLog: async (stream, chunk) => {
      if (stream === "stdout") stdout += chunk;
    },
  });
  expect(result.exitCode).toBe(0);
  return JSON.parse(stdout) as Record<string, string>;
}

describe("selectInheritedAgentEnv", () => {
  it("keeps the default list and drops every other server variable", () => {
    const selected = selectInheritedAgentEnv(SERVER_ENV);
    expect(selected).toMatchObject({
      PATH: "/usr/bin:/bin",
      HOME: "/home/server",
      LC_ALL: "C.UTF-8",
      ANTHROPIC_API_KEY: "sk-ant-harness",
    });
    for (const key of [...DROPPED, "EXTRA_TOKEN", "PAPERCLIP_HOME", "PAPERCLIP_API_KEY"]) {
      expect(selected).not.toHaveProperty(key);
    }
  });

  it("matches names case-insensitively and PREFIX_* patterns", () => {
    const selected = selectInheritedAgentEnv(
      { http_proxy: "http://proxy", ACME_ONE: "1", ACMEX: "2" },
      { extraPatterns: ["ACME_*"] },
    );
    expect(selected).toEqual({ http_proxy: "http://proxy", ACME_ONE: "1" });
  });

  it("lists no variable that the server uses for its own secrets", () => {
    const names = DEFAULT_AGENT_ENV_ALLOWLIST.map((entry) => entry.toUpperCase());
    expect(names).not.toContain("DATABASE_URL");
    expect(names).not.toContain("BETTER_AUTH_SECRET");
    expect(names.some((entry) => entry.startsWith("PAPERCLIP_"))).toBe(false);
  });

  it("uses an instance list in place of the default and lets an agent only add", () => {
    const policy = { allowlist: ["PATH"], inheritEnv: ["EXTRA_*"] };
    expect(selectInheritedAgentEnv(SERVER_ENV, { policy })).toEqual({
      PATH: "/usr/bin:/bin",
      EXTRA_TOKEN: "extra-token",
    });
  });

  it("ignores malformed and reserved patterns", () => {
    expect(normalizeAgentEnvPatterns(["OK", "*", "BAD NAME", "PAPERCLIP_*", "PAPERCLIP_API_KEY", 7, "A_*", "A_*"]))
      .toEqual(["OK", "A_*"]);
  });
});

describe.each([
  ["runChildProcess", childEnvViaRunChildProcess],
  ["execution-target", childEnvViaExecutionTarget],
])("%s child environment", (_name, run) => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(SERVER_ENV)) vi.stubEnv(key, value);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("drops server secrets and keeps default, Paperclip and adapter env", async () => {
    const env = await run({
      PAPERCLIP_API_KEY: "run-jwt",
      PAPERCLIP_RUN_ID: "run-1",
      CONFIGURED_BY_AGENT: "from-adapter-config",
    });
    for (const key of DROPPED) expect(env).not.toHaveProperty(key);
    expect(env.PATH).toBeTruthy();
    expect(env.HOME).toBe("/home/server");
    expect(env.PAPERCLIP_API_KEY).toBe("run-jwt");
    expect(env.PAPERCLIP_RUN_ID).toBe("run-1");
    expect(env.CONFIGURED_BY_AGENT).toBe("from-adapter-config");
  });

  it("passes an inheritEnv entry through, and only that entry", async () => {
    const env = await runWithAgentEnvPolicy({ inheritEnv: ["FOO_SECRET"] }, () => run({}));
    expect(env.FOO_SECRET).toBe("foo-secret");
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("BETTER_AUTH_SECRET");
  });

  it("applies the default to a run that sets no policy at all", async () => {
    const env = await run({});
    expect(env).not.toHaveProperty("FOO_SECRET");
  });
});

describe("acpx-engine launch environment", () => {
  it("drops server secrets and honours inheritEnv", () => {
    const launch = (policy?: { inheritEnv: string[] }) =>
      runWithAgentEnvPolicy(policy ?? {}, () =>
        finalizeLaunchEnvironment(
          { PAPERCLIP_API_KEY: "run-jwt", PAPERCLIP_RUN_ID: "run-1", CONFIGURED_BY_AGENT: "cfg" },
          [],
          { acpxAgent: "kimi", inheritHostEnvironment: true, inheritedEnv: SERVER_ENV },
        ).env,
      );
    const env = launch();
    for (const key of DROPPED) expect(env).not.toHaveProperty(key);
    expect(env).toMatchObject({
      PATH: "/usr/bin:/bin",
      HOME: "/home/server",
      PAPERCLIP_API_KEY: "run-jwt",
      PAPERCLIP_RUN_ID: "run-1",
      CONFIGURED_BY_AGENT: "cfg",
    });
    expect(launch({ inheritEnv: ["FOO_SECRET"] }).FOO_SECRET).toBe("foo-secret");
  });
});
