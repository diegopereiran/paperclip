import { describe, expect, it } from "vitest";
import {
  agentProcessPolicyWidening,
  currentAgentProcessPolicy,
  mergeAgentProcessPolicy,
  normalizeAgentProcessPolicy,
  runWithAgentProcessPolicy,
} from "./agent-process-policy.js";
import { agentProcessPolicySchema, findUnsafeBindPath } from "@paperclipai/shared";

describe("normalizeAgentProcessPolicy", () => {
  it("returns an empty policy for anything that is not an object", () => {
    for (const value of [null, undefined, "x", 3, [], true]) {
      expect(normalizeAgentProcessPolicy(value)).toEqual({});
    }
  });

  it("keeps valid fields, drops unknown fields and invalid entries", () => {
    expect(
      normalizeAgentProcessPolicy({
        mode: "enforce",
        bogus: 1,
        filesystem: { scope: "workspace", rw: ["/srv/a", "relative", 4, "/srv/a/"], ro: ["/etc/x"], gitDir: "nope" },
        network: { scope: "allowlist", allowlist: ["api.example.com", "", 5] },
        commandWrapper: ["/usr/bin/nice", "-n", "5"],
      }),
    ).toEqual({
      mode: "enforce",
      filesystem: { scope: "workspace", rw: ["/srv/a"], ro: ["/etc/x"] },
      network: { scope: "allowlist", allowlist: ["api.example.com"] },
      commandWrapper: ["/usr/bin/nice", "-n", "5"],
    });
  });

  it("drops a command wrapper whose first entry is not absolute", () => {
    expect(normalizeAgentProcessPolicy({ commandWrapper: ["nice", "-n", "5"] })).toEqual({});
  });

  it("drops bind paths under a forbidden root when roots are given", () => {
    const policy = normalizeAgentProcessPolicy(
      { filesystem: { rw: ["/home/u", "/home/u/.cache/x", "/"] } },
      { bindRoots: { homeDirs: ["/home/u"] } },
    );
    expect(policy).toEqual({ filesystem: { rw: ["/home/u/.cache/x"] } });
  });
});

describe("mergeAgentProcessPolicy", () => {
  it("lets the most specific layer win for scalars", () => {
    const merged = mergeAgentProcessPolicy(
      { mode: "enforce", network: { scope: "shared" }, filesystem: { scope: "workspace", gitDir: "auto" } },
      { network: { scope: "allowlist", allowlist: ["a.example.com"] } },
      { mode: "off", network: { scope: "deny" } },
    );
    expect(merged.mode).toBe("off");
    expect(merged.network).toEqual({ scope: "deny", allowlist: ["a.example.com"] });
    expect(merged.filesystem).toEqual({ scope: "workspace", gitDir: "auto" });
  });

  it("takes the allowlist and wrapper from the most specific layer that sets them", () => {
    const merged = mergeAgentProcessPolicy(
      { network: { allowlist: ["a.example.com"] }, commandWrapper: ["/usr/bin/env"] },
      { network: { allowlist: ["b.example.com"] } },
      { commandWrapper: ["/usr/bin/nice"] },
    );
    expect(merged.network?.allowlist).toEqual(["b.example.com"]);
    expect(merged.commandWrapper).toEqual(["/usr/bin/nice"]);
  });

  it("unions rw and ro across layers without duplicates", () => {
    const merged = mergeAgentProcessPolicy(
      { filesystem: { rw: ["/srv/a"], ro: ["/etc/x"] } },
      { filesystem: { rw: ["/srv/b", "/srv/a"] } },
      { filesystem: { ro: ["/etc/y"] } },
    );
    expect(merged.filesystem?.rw).toEqual(["/srv/a", "/srv/b"]);
    expect(merged.filesystem?.ro).toEqual(["/etc/x", "/etc/y"]);
  });

  it("treats null, undefined and empty layers as having no opinion", () => {
    const instance = { mode: "enforce" as const, network: { scope: "deny" as const } };
    expect(mergeAgentProcessPolicy(instance, null, undefined)).toEqual(instance);
    expect(mergeAgentProcessPolicy(instance, null, {})).toEqual(instance);
    expect(mergeAgentProcessPolicy(null, null, null)).toEqual({});
  });

  it("does not mutate its inputs", () => {
    const instance = { filesystem: { rw: ["/srv/a"] } };
    const agent = { filesystem: { rw: ["/srv/b"] } };
    mergeAgentProcessPolicy(instance, null, agent);
    expect(instance).toEqual({ filesystem: { rw: ["/srv/a"] } });
    expect(agent).toEqual({ filesystem: { rw: ["/srv/b"] } });
  });
});

describe("agentProcessPolicyWidening", () => {
  it("reports nothing when nothing changes", () => {
    const policy = { mode: "enforce" as const, filesystem: { rw: ["/srv/a"] }, network: { scope: "deny" as const } };
    expect(agentProcessPolicyWidening(policy, policy)).toEqual([]);
    expect(agentProcessPolicyWidening(undefined, undefined)).toEqual([]);
  });

  it("flags turning mode off", () => {
    expect(agentProcessPolicyWidening(undefined, { mode: "off" })).toEqual(["mode"]);
    expect(agentProcessPolicyWidening({ mode: "enforce" }, { mode: "off" })).toEqual(["mode"]);
    expect(agentProcessPolicyWidening({ mode: "off" }, { mode: "off" })).toEqual([]);
  });

  it("flags removing a mode of enforce", () => {
    expect(agentProcessPolicyWidening({ mode: "enforce" }, {})).toEqual(["mode"]);
  });

  it("flags an added rw or ro path but not a removed one", () => {
    expect(agentProcessPolicyWidening({ filesystem: { rw: ["/srv/a"] } }, { filesystem: { rw: ["/srv/a", "/srv/b"] } }))
      .toEqual(["filesystem.rw"]);
    expect(agentProcessPolicyWidening(undefined, { filesystem: { ro: ["/etc/x"] } })).toEqual(["filesystem.ro"]);
    expect(agentProcessPolicyWidening({ filesystem: { rw: ["/srv/a", "/srv/b"] } }, { filesystem: { rw: ["/srv/a"] } }))
      .toEqual([]);
  });

  it("flags a wider network scope and allows a narrower one", () => {
    expect(agentProcessPolicyWidening({ network: { scope: "deny" } }, { network: { scope: "allowlist" } }))
      .toEqual(["network.scope"]);
    expect(agentProcessPolicyWidening({ network: { scope: "allowlist" } }, { network: { scope: "shared" } }))
      .toEqual(["network.scope"]);
    expect(agentProcessPolicyWidening(undefined, { network: { scope: "shared" } })).toEqual(["network.scope"]);
    expect(agentProcessPolicyWidening({ network: { scope: "shared" } }, { network: { scope: "deny" } })).toEqual([]);
    expect(agentProcessPolicyWidening(undefined, { network: { scope: "deny" } })).toEqual([]);
  });

  it("flags removing a restrictive network scope", () => {
    expect(agentProcessPolicyWidening({ network: { scope: "deny" } }, {})).toEqual(["network.scope"]);
  });

  it("flags an added allowlist entry", () => {
    expect(
      agentProcessPolicyWidening(
        { network: { scope: "allowlist", allowlist: ["a.example.com"] } },
        { network: { scope: "allowlist", allowlist: ["a.example.com", "b.example.com"] } },
      ),
    ).toEqual(["network.allowlist"]);
    expect(
      agentProcessPolicyWidening(
        { network: { allowlist: ["a.example.com", "b.example.com"] } },
        { network: { allowlist: ["a.example.com"] } },
      ),
    ).toEqual([]);
  });

  it("flags removing an allowlist the layer carried", () => {
    expect(
      agentProcessPolicyWidening({ network: { scope: "allowlist", allowlist: ["a.example.com"] } }, { network: { scope: "allowlist" } }),
    ).toEqual(["network.allowlist"]);
    expect(agentProcessPolicyWidening({ network: { allowlist: ["a.example.com"] } }, {})).toEqual(["network.allowlist"]);
    expect(
      agentProcessPolicyWidening({ network: { scope: "allowlist", allowlist: ["a.example.com"] } }, { network: { scope: "deny" } }),
    ).toEqual([]);
    expect(agentProcessPolicyWidening({ network: { allowlist: ["a.example.com"] } }, { network: { allowlist: [] } }))
      .toEqual(["network.allowlist"]);
  });

  it("flags setting, changing or clearing the command wrapper", () => {
    expect(agentProcessPolicyWidening(undefined, { commandWrapper: ["/usr/bin/env"] })).toEqual(["commandWrapper"]);
    expect(agentProcessPolicyWidening({ commandWrapper: ["/usr/bin/env"] }, { commandWrapper: ["/usr/bin/nice"] }))
      .toEqual(["commandWrapper"]);
    expect(agentProcessPolicyWidening({ commandWrapper: ["/usr/bin/env"] }, { commandWrapper: ["/usr/bin/env"] }))
      .toEqual([]);
    expect(agentProcessPolicyWidening({ commandWrapper: ["/usr/bin/env"] }, {})).toEqual(["commandWrapper"]);
  });

  it("flags a git dir of auto set over off and removing off or the workspace scope", () => {
    expect(agentProcessPolicyWidening({ filesystem: { gitDir: "off" } }, { filesystem: { gitDir: "auto" } }))
      .toEqual(["filesystem.gitDir"]);
    expect(agentProcessPolicyWidening({ filesystem: { gitDir: "off" } }, {})).toEqual(["filesystem.gitDir"]);
    expect(agentProcessPolicyWidening({ filesystem: { scope: "workspace" } }, {})).toEqual(["filesystem.scope"]);
    expect(agentProcessPolicyWidening(undefined, { filesystem: { gitDir: "off" } })).toEqual([]);
  });

  it("lists every widening kind once", () => {
    expect(
      agentProcessPolicyWidening(undefined, {
        mode: "off",
        filesystem: { rw: ["/srv/a"], ro: ["/srv/b"] },
        network: { scope: "shared", allowlist: ["a.example.com"] },
        commandWrapper: ["/usr/bin/env"],
      }).sort(),
    ).toEqual(["commandWrapper", "filesystem.ro", "filesystem.rw", "mode", "network.allowlist", "network.scope"]);
  });
});

describe("unsafe bind paths (A4)", () => {
  const roots = { homeDirs: ["/home/svc"], paperclipDirs: ["/home/svc/.paperclip", "/home/svc/.paperclip/instances/default"] };

  it.each([
    "/",
    "/home",
    "/home/svc",
    "/home/svc/",
    "/home/svc/.paperclip",
    "/home/svc/.paperclip/instances/default",
    "/home/svc/.paperclip/instances",
    "/run",
    "/run/postgresql",
    "/var/run/postgresql",
    "/var",
    "relative/path",
    "./x",
    "/srv/../etc",
    "",
  ])("rejects %j", (value) => {
    expect(findUnsafeBindPath(value, roots)).not.toBeNull();
  });

  it.each([
    "/srv/remote-build",
    "/home/svc/.cache/tool",
    "/home/svc/.paperclip/instances/default/companies/c1/agents/a1/codex-home",
    "/var/lib/remote-build/leases",
    "/run/user/1000/x",
  ])("accepts the narrower subpath %j", (value) => {
    expect(findUnsafeBindPath(value, roots)).toBeNull();
  });

  it("rejects the static roots in the shared schema without host knowledge", () => {
    expect(agentProcessPolicySchema.safeParse({ filesystem: { rw: ["/"] } }).success).toBe(false);
    expect(agentProcessPolicySchema.safeParse({ filesystem: { ro: ["/run/postgresql"] } }).success).toBe(false);
    expect(agentProcessPolicySchema.safeParse({ filesystem: { ro: ["etc/x"] } }).success).toBe(false);
    expect(agentProcessPolicySchema.safeParse({ filesystem: { rw: ["/srv/x"] } }).success).toBe(true);
  });

  it("requires an absolute first commandWrapper entry in the shared schema", () => {
    expect(agentProcessPolicySchema.safeParse({ commandWrapper: ["nice", "-n", "5"] }).success).toBe(false);
    expect(agentProcessPolicySchema.safeParse({ commandWrapper: ["/usr/bin/nice", "-n", "5"] }).success).toBe(true);
    expect(agentProcessPolicySchema.safeParse({ commandWrapper: [] }).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(agentProcessPolicySchema.safeParse({ filesystem: { nope: [] } }).success).toBe(false);
    expect(agentProcessPolicySchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("runWithAgentProcessPolicy", () => {
  it("carries the policy to async work and clears it afterwards", async () => {
    expect(currentAgentProcessPolicy()).toBeUndefined();
    const seen = await runWithAgentProcessPolicy({ mode: "enforce" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentAgentProcessPolicy();
    });
    expect(seen).toEqual({ mode: "enforce" });
    expect(currentAgentProcessPolicy()).toBeUndefined();
  });
});
