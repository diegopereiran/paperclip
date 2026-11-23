import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { agentRuntimeConfigSchema, instanceGeneralSettingsSchema } from "@paperclipai/shared";
import {
  DEFAULT_AGENT_ENV_ALLOWLIST,
  resolveAgentEnvPatterns,
  runWithAgentEnvPolicy,
  selectInheritedAgentEnv,
} from "@paperclipai/adapter-utils/agent-env-policy";
import { instanceSettingsService } from "../services/instance-settings.js";

function stubDb(general: Record<string, unknown>) {
  const row = {
    id: "row-1",
    singletonKey: "default",
    defaultEnvironmentId: null,
    general,
    experimental: {},
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
  };
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve([row]) }) }),
    insert: () => {
      throw new Error("unexpected insert in test");
    },
  } as unknown as Db;
}

describe("agent environment allow-list is an instance-wide default", () => {
  it("has no company key: the setting row is the instance singleton", async () => {
    const general = await instanceSettingsService(stubDb({})).getGeneral();
    expect(general.agentEnvAllowlist).toBeUndefined();
    expect(general).not.toHaveProperty("companyId");
  });

  it("applies the built-in default to a company created later with no setup step", () => {
    const env = { PATH: "/bin", HOME: "/home/x", DATABASE_URL: "postgres://s", ANTHROPIC_API_KEY: "k" };
    // No stored setting, no agent override, no per-company state: only the code default.
    expect(resolveAgentEnvPatterns(null)).toEqual([...DEFAULT_AGENT_ENV_ALLOWLIST]);
    expect(selectInheritedAgentEnv(env)).toEqual({ PATH: "/bin", HOME: "/home/x", ANTHROPIC_API_KEY: "k" });
    const seenByCompany = ["company-existing", "company-created-later"].map(() =>
      runWithAgentEnvPolicy({ allowlist: null, inheritEnv: [] }, () => selectInheritedAgentEnv(env)),
    );
    expect(seenByCompany[1]).toEqual(seenByCompany[0]);
    expect(seenByCompany[1]).not.toHaveProperty("DATABASE_URL");
  });

  it("stores and returns an instance list that replaces the default for every company", async () => {
    const stored = { agentEnvAllowlist: ["PATH", "HOME", "GH_*"] };
    const general = await instanceSettingsService(stubDb(stored)).getGeneral();
    expect(general.agentEnvAllowlist).toEqual(["PATH", "HOME", "GH_*"]);
    expect(
      selectInheritedAgentEnv({ PATH: "/bin", GH_TOKEN: "t", LANG: "C" }, { policy: { allowlist: general.agentEnvAllowlist } }),
    ).toEqual({ PATH: "/bin", GH_TOKEN: "t" });
  });

  it("validates the instance setting and rejects the reserved PAPERCLIP_ namespace", () => {
    expect(instanceGeneralSettingsSchema.safeParse({ agentEnvAllowlist: ["PATH", "FOO_*"] }).success).toBe(true);
    expect(instanceGeneralSettingsSchema.safeParse({ agentEnvAllowlist: ["PAPERCLIP_*"] }).success).toBe(false);
    expect(instanceGeneralSettingsSchema.safeParse({ agentEnvAllowlist: ["bad name"] }).success).toBe(false);
  });

  it("validates the agent override as names or PREFIX_* and lets it only add", () => {
    expect(agentRuntimeConfigSchema.safeParse({ inheritEnv: ["GH_TOKEN", "FOO_*"] }).success).toBe(true);
    expect(agentRuntimeConfigSchema.safeParse({ inheritEnv: ["PAPERCLIP_API_KEY"] }).success).toBe(false);
    expect(agentRuntimeConfigSchema.safeParse({ inheritEnv: ["*"] }).success).toBe(false);
    const env = { PATH: "/bin", GH_TOKEN: "t" };
    expect(selectInheritedAgentEnv(env, { policy: { allowlist: ["PATH"], inheritEnv: ["GH_TOKEN"] } })).toEqual(env);
  });
});
