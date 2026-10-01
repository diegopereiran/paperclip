import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentProcessPolicySchema,
  findUnsafeBindPath,
  type AgentProcessBindRoots,
  type AgentProcessPolicy,
} from "@paperclipai/shared";
import {
  agentProcessPolicyWidening,
  mergeAgentProcessPolicy,
  normalizeAgentProcessPolicy,
} from "@paperclipai/adapter-utils/agent-process-policy";
import { resolvePaperclipHomeDir, resolvePaperclipInstanceRoot } from "../home-paths.js";
import { unprocessable } from "../errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function realpathOrNull(value: string): string | null {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

/** Roots a bind path may not equal or contain: the server user's home and the Paperclip home. */
export function agentProcessPolicyBindRoots(): AgentProcessBindRoots {
  const homeDirs = new Set<string>();
  for (const home of [os.homedir(), process.env.HOME]) {
    if (home && path.isAbsolute(home)) homeDirs.add(path.resolve(home));
  }
  const paperclipDirs = [resolvePaperclipHomeDir(), resolvePaperclipInstanceRoot()];
  return { homeDirs: [...homeDirs], paperclipDirs };
}

/** The process policy stored on an agent runtimeConfig (or hire payload runtimeConfig), if any. */
export function readRuntimeConfigProcessPolicy(runtimeConfig: unknown): unknown {
  return isRecord(runtimeConfig) ? runtimeConfig.processPolicy : undefined;
}

/**
 * Reject a policy that is malformed or whose rw/ro entries name an unsafe bind
 * (A4): the filesystem root or an ancestor of it, the server user's home, the
 * Paperclip home, the instance root, the Postgres sockets, or a relative path.
 * A symlink that resolves onto one of those roots is rejected too.
 */
export function assertAgentProcessPolicyValid(value: unknown): AgentProcessPolicy | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = agentProcessPolicySchema.safeParse(value);
  if (!parsed.success) {
    throw unprocessable("Invalid agent process policy", {
      code: "invalid_agent_process_policy",
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  const roots = agentProcessPolicyBindRoots();
  for (const kind of ["rw", "ro"] as const) {
    for (const entry of parsed.data.filesystem?.[kind] ?? []) {
      const resolved = realpathOrNull(entry);
      const reason = findUnsafeBindPath(entry, roots) ?? (resolved ? findUnsafeBindPath(resolved, roots) : null);
      if (reason) {
        throw unprocessable("Invalid agent process policy", {
          code: "invalid_agent_process_policy",
          issues: [{ path: `filesystem.${kind}`, message: `${entry} ${reason}` }],
        });
      }
    }
  }
  return parsed.data;
}

/** Layer value for the run: tolerant read that drops unsafe binds instead of throwing. */
export function readAgentProcessPolicyLayer(value: unknown): AgentProcessPolicy {
  return normalizeAgentProcessPolicy(value, { bindRoots: agentProcessPolicyBindRoots() });
}

/**
 * The value an activated hire may carry: the approval payload's policy only if
 * it does not widen the one the pending row already holds (set through the
 * guarded hire route); otherwise the row's own value.
 */
export function carriedProcessPolicyForActivation(approved: unknown, carried: unknown): unknown {
  const approvedPolicy = normalizeAgentProcessPolicy(approved, { bindRoots: agentProcessPolicyBindRoots() });
  if (agentProcessPolicyWidening(carried as AgentProcessPolicy | undefined, approvedPolicy).length > 0) {
    return carried;
  }
  return Object.keys(approvedPolicy).length > 0 ? approvedPolicy : undefined;
}

/**
 * The policy for one run: instance default, then company, then agent, the most
 * specific layer winning (rw/ro union). The company layer is null until a
 * company-level setting exists; every company then inherits the instance layer.
 */
export function resolveAgentProcessPolicy(layers: {
  instance: unknown;
  company?: unknown;
  agentRuntimeConfig: unknown;
}): AgentProcessPolicy {
  return mergeAgentProcessPolicy(
    readAgentProcessPolicyLayer(layers.instance),
    layers.company == null ? null : readAgentProcessPolicyLayer(layers.company),
    readAgentProcessPolicyLayer(readRuntimeConfigProcessPolicy(layers.agentRuntimeConfig)),
  );
}
