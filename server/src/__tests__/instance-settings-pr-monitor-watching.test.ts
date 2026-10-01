import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  agentRuntimeConfigSchema,
  instanceGeneralSettingsSchema,
  patchInstanceGeneralSettingsSchema,
  updateCompanySchema,
} from "@paperclipai/shared";
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

describe("native pull request watching is an instance-wide default", () => {
  it("is absent from a fresh instance, which means on, and has no company key", async () => {
    const general = await instanceSettingsService(stubDb({})).getGeneral();
    expect(general.prMonitorWatching).toBeUndefined();
    expect(general).not.toHaveProperty("companyId");
  });

  it("returns an explicit instance switch", async () => {
    expect((await instanceSettingsService(stubDb({ prMonitorWatching: false })).getGeneral()).prMonitorWatching).toBe(false);
    expect((await instanceSettingsService(stubDb({ prMonitorWatching: true })).getGeneral()).prMonitorWatching).toBe(true);
  });

  it("validates the instance switch and the company and agent overrides as booleans", () => {
    expect(instanceGeneralSettingsSchema.safeParse({ prMonitorWatching: false }).success).toBe(true);
    expect(instanceGeneralSettingsSchema.safeParse({ prMonitorWatching: "off" }).success).toBe(false);
    expect(patchInstanceGeneralSettingsSchema.safeParse({ prMonitorWatching: false }).success).toBe(true);
    expect(agentRuntimeConfigSchema.safeParse({ prMonitorWatching: false }).success).toBe(true);
    expect(agentRuntimeConfigSchema.safeParse({ prMonitorWatching: "no" }).success).toBe(false);
    expect(updateCompanySchema.safeParse({ prMonitorWatching: false }).success).toBe(true);
    expect(updateCompanySchema.safeParse({ prMonitorWatching: null }).success).toBe(true);
    expect(updateCompanySchema.safeParse({ prMonitorWatching: "no" }).success).toBe(false);
  });
});
