import { AsyncLocalStorage } from "node:async_hooks";
import {
  cleanAbsoluteBindPath,
  findUnsafeBindPath,
  type AgentProcessBindRoots,
  type AgentProcessPolicy,
} from "@paperclipai/shared";

export type { AgentProcessPolicy } from "@paperclipai/shared";

const NETWORK_SCOPE_RANK = { deny: 0, allowlist: 1, shared: 2 } as const;
type NetworkScope = keyof typeof NETWORK_SCOPE_RANK;

export type NormalizeAgentProcessPolicyOptions = {
  /** Host-specific roots a bind path may not equal or contain. */
  bindRoots?: AgentProcessBindRoots;
};

function normalizeBindPaths(value: unknown, roots: AgentProcessBindRoots | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const entry of value) {
    if (findUnsafeBindPath(entry, roots) !== null) continue;
    const cleaned = cleanAbsoluteBindPath(entry);
    if (cleaned) seen.add(cleaned);
  }
  return seen.size > 0 ? [...seen] : undefined;
}

function normalizeAllowlist(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > 2048 || /[\s*]/.test(trimmed)) continue;
    seen.add(trimmed);
  }
  return seen.size > 0 ? [...seen] : undefined;
}

function normalizeCommandWrapper(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return undefined;
  if (!value.every((part) => typeof part === "string" && part.length > 0 && !part.includes("\0"))) return undefined;
  if (!(value[0] as string).startsWith("/")) return undefined;
  return [...(value as string[])];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Tolerant reader for a stored policy layer: keep valid known fields and drop
 * the rest, so a bad value can only make a layer weaker, never throw at spawn.
 * Write-time validation lives in `agentProcessPolicySchema`.
 */
export function normalizeAgentProcessPolicy(
  value: unknown,
  options: NormalizeAgentProcessPolicyOptions = {},
): AgentProcessPolicy {
  if (!isRecord(value)) return {};
  const policy: AgentProcessPolicy = {};
  if (value.mode === "off" || value.mode === "enforce") policy.mode = value.mode;

  if (isRecord(value.filesystem)) {
    const filesystem: NonNullable<AgentProcessPolicy["filesystem"]> = {};
    if (value.filesystem.scope === "workspace") filesystem.scope = "workspace";
    const rw = normalizeBindPaths(value.filesystem.rw, options.bindRoots);
    if (rw) filesystem.rw = rw;
    const ro = normalizeBindPaths(value.filesystem.ro, options.bindRoots);
    if (ro) filesystem.ro = ro;
    if (value.filesystem.gitDir === "auto" || value.filesystem.gitDir === "off") {
      filesystem.gitDir = value.filesystem.gitDir;
    }
    if (Object.keys(filesystem).length > 0) policy.filesystem = filesystem;
  }

  if (isRecord(value.network)) {
    const network: NonNullable<AgentProcessPolicy["network"]> = {};
    if (value.network.scope === "shared" || value.network.scope === "deny" || value.network.scope === "allowlist") {
      network.scope = value.network.scope;
    }
    const allowlist = normalizeAllowlist(value.network.allowlist);
    if (allowlist) network.allowlist = allowlist;
    if (Object.keys(network).length > 0) policy.network = network;
  }

  const commandWrapper = normalizeCommandWrapper(value.commandWrapper);
  if (commandWrapper) policy.commandWrapper = commandWrapper;
  return policy;
}

function union(...lists: Array<readonly string[] | undefined>): string[] | undefined {
  const seen = new Set<string>();
  for (const list of lists) for (const entry of list ?? []) seen.add(entry);
  return seen.size > 0 ? [...seen] : undefined;
}

/**
 * Merge policy layers, least specific first (instance, company, agent). The
 * most specific layer that sets a scalar wins; `filesystem.rw` and `ro` are
 * unions; a null, undefined or empty layer has no opinion.
 */
export function mergeAgentProcessPolicy(
  ...layers: ReadonlyArray<AgentProcessPolicy | null | undefined>
): AgentProcessPolicy {
  const merged: AgentProcessPolicy = {};
  const filesystem: NonNullable<AgentProcessPolicy["filesystem"]> = {};
  const network: NonNullable<AgentProcessPolicy["network"]> = {};
  const rwLists: Array<readonly string[] | undefined> = [];
  const roLists: Array<readonly string[] | undefined> = [];
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.mode !== undefined) merged.mode = layer.mode;
    if (layer.filesystem?.scope !== undefined) filesystem.scope = layer.filesystem.scope;
    if (layer.filesystem?.gitDir !== undefined) filesystem.gitDir = layer.filesystem.gitDir;
    rwLists.push(layer.filesystem?.rw);
    roLists.push(layer.filesystem?.ro);
    if (layer.network?.scope !== undefined) network.scope = layer.network.scope;
    if (layer.network?.allowlist !== undefined) network.allowlist = [...layer.network.allowlist];
    if (layer.commandWrapper !== undefined) merged.commandWrapper = [...layer.commandWrapper];
  }
  const rw = union(...rwLists);
  if (rw) filesystem.rw = rw;
  const ro = union(...roLists);
  if (ro) filesystem.ro = ro;
  if (Object.keys(filesystem).length > 0) merged.filesystem = filesystem;
  if (Object.keys(network).length > 0) merged.network = network;
  return merged;
}

function addedEntries(previous: readonly string[] | undefined, next: readonly string[] | undefined): boolean {
  const known = new Set(previous ?? []);
  return (next ?? []).some((entry) => !known.has(entry));
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((entry, index) => entry === (b ?? [])[index]);
}

/**
 * Which fields of `next` loosen confinement compared with `previous` (one
 * layer's value before and after a write). An empty result means the write only
 * narrows or keeps the layer. Widening at company or agent level needs an
 * instance admin. An absent previous network scope counts as the narrowest
 * (`deny`), so setting any wider scope on a layer that had none is widening.
 * Removing a restriction the layer carried is widening too, because the layer
 * then falls back to a wider lower-priority value.
 */
export function agentProcessPolicyWidening(
  previousRaw: AgentProcessPolicy | null | undefined,
  nextRaw: AgentProcessPolicy | null | undefined,
): string[] {
  const previous = normalizeAgentProcessPolicy(previousRaw);
  const next = normalizeAgentProcessPolicy(nextRaw);
  const kinds: string[] = [];

  if ((next.mode === "off" && previous.mode !== "off") || (previous.mode === "enforce" && next.mode !== "enforce")) {
    kinds.push("mode");
  }

  if (previous.filesystem?.scope !== undefined && next.filesystem?.scope === undefined) kinds.push("filesystem.scope");
  if (addedEntries(previous.filesystem?.rw, next.filesystem?.rw)) kinds.push("filesystem.rw");
  if (addedEntries(previous.filesystem?.ro, next.filesystem?.ro)) kinds.push("filesystem.ro");
  if (
    (next.filesystem?.gitDir === "auto" && previous.filesystem?.gitDir !== "auto")
    || (previous.filesystem?.gitDir === "off" && next.filesystem?.gitDir === undefined)
  ) {
    kinds.push("filesystem.gitDir");
  }

  const previousScope = previous.network?.scope as NetworkScope | undefined;
  const nextScope = next.network?.scope as NetworkScope | undefined;
  const previousRank = previousScope ? NETWORK_SCOPE_RANK[previousScope] : NETWORK_SCOPE_RANK.deny;
  if (
    (nextScope !== undefined && NETWORK_SCOPE_RANK[nextScope] > previousRank)
    || (nextScope === undefined && previousScope !== undefined && previousScope !== "shared")
  ) {
    kinds.push("network.scope");
  }
  if (
    addedEntries(previous.network?.allowlist, next.network?.allowlist)
    || (previous.network?.allowlist?.length && !next.network?.allowlist?.length && nextScope !== "deny")
  ) {
    kinds.push("network.allowlist");
  }

  if (
    (next.commandWrapper !== undefined && !sameList(previous.commandWrapper, next.commandWrapper))
    || (previous.commandWrapper !== undefined && next.commandWrapper === undefined)
  ) {
    kinds.push("commandWrapper");
  }
  return kinds;
}

const policyStorage = new AsyncLocalStorage<AgentProcessPolicy>();

/**
 * Run `fn` with the policy the server resolved for one agent run. Launch paths
 * read it from here, so no adapter threads it through its own config.
 */
export function runWithAgentProcessPolicy<T>(policy: AgentProcessPolicy, fn: () => T): T {
  return policyStorage.run(policy, fn);
}

export function currentAgentProcessPolicy(): AgentProcessPolicy | undefined {
  return policyStorage.getStore();
}
