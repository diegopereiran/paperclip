export type AgentProcessPolicyMode = "off" | "enforce";
export type AgentProcessFilesystemScope = "workspace";
export type AgentProcessGitDir = "auto" | "off";
export type AgentProcessNetworkScope = "shared" | "deny" | "allowlist";

/**
 * Adapter-neutral confinement for spawned agent processes. Every field is
 * optional: an absent field has no opinion, so a layer (instance, company,
 * agent) only states what it changes.
 */
export interface AgentProcessPolicy {
  /** Code default is "off": nothing is confined until a layer sets "enforce". */
  mode?: AgentProcessPolicyMode;
  filesystem?: {
    /** Absent means unconfined. */
    scope?: AgentProcessFilesystemScope;
    /** Absolute host-local paths bound read-write. Unioned across layers. */
    rw?: string[];
    /** Absolute paths bound read-only. Unioned across layers. */
    ro?: string[];
    gitDir?: AgentProcessGitDir;
  };
  network?: {
    scope?: AgentProcessNetworkScope;
    /** Used only when scope is "allowlist". */
    allowlist?: string[];
  };
  /** Argv prefix that runs outside the confinement and execs the rest. */
  commandWrapper?: string[];
}
