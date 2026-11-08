import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Environment allow-list for every spawned agent process. A variable of the
 * server's own environment reaches the agent only when a pattern here (or an
 * instance/agent extension) names it. There is no deny-list: a new server
 * secret such as DATABASE_URL or BETTER_AUTH_SECRET is excluded by default.
 *
 * A pattern is an exact variable name or a `PREFIX_*` prefix. Matching is
 * case-insensitive so `Path` and `http_proxy` behave like `PATH`/`HTTP_PROXY`.
 */
export const BASE_AGENT_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  // Process identity and shell: every CLI needs these to start.
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TMPDIR", "TZ",
  "LANG", "LANGUAGE", "LC_*",
  // Windows equivalents of the above (same purpose, inert elsewhere).
  "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "USERPROFILE", "USERNAME",
  "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP",
  // XDG base directories: where CLIs keep their config and caches.
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  // Network trust and proxies: needed to reach a provider from behind one.
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
]);

// Each harness CLI finds its login, config home and model here. The ACP engine
// does not use this list: it passes only the entries of the agent it launches.
export const HARNESS_AGENT_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "CLAUDE_*", // claude_local: CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK
  "DISABLE_AUTOUPDATER", // claude_local: keeps an operator-pinned Claude Code version from self-updating mid-run
  "ANTHROPIC_*", // claude_local: ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, Bedrock base URL
  "CODEX_*", // codex_local: CODEX_HOME, CODEX_API_KEY
  "OPENAI_*", // codex_local, opencode_local, pi_local: OPENAI_API_KEY, OPENAI_BASE_URL
  "GEMINI_*", // gemini_local: GEMINI_API_KEY
  "KIMI_*", // kimi_local: KIMI_API_KEY, KIMI_CODE_HOME, KIMI_MODEL_*
  "CURSOR_*", // cursor_local: CURSOR_API_KEY
  "OPENCODE_*", // opencode_local: OPENCODE_ALLOW_ALL_MODELS
  // Named one by one: these share a vendor namespace with unrelated secrets.
  "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_GENAI_USE_GCA", // gemini_local
  "MOONSHOT_API_KEY", // kimi_local
  "XAI_API_KEY", // grok_local
  "GROK_HOME", // grok_local: an inherited host home is the sign-in fallback (v2026.1001.0, #13570)
  "OPENROUTER_API_KEY", // pi_local, opencode_local
  "ZAI_API_KEY", "MINIMAX_API_KEY", // hermes_local: provider keys its environment test also reads
  "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_CONFIG_FILE", // claude_local on Bedrock: non-secret selectors only
]);

export const DEFAULT_AGENT_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  ...BASE_AGENT_ENV_ALLOWLIST,
  ...HARNESS_AGENT_ENV_ALLOWLIST,
]);

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_PREFIX_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*_\*$/;

export type AgentEnvPolicy = {
  /** Instance-wide list. Absent means DEFAULT_AGENT_ENV_ALLOWLIST. */
  allowlist?: readonly string[] | null;
  /** Agent extension on top of the instance list. It can only add. */
  inheritEnv?: readonly string[] | null;
};

/**
 * Keep valid names and `PREFIX_*` patterns; drop everything else. PAPERCLIP_*
 * is the reserved runtime namespace, so a pattern there is dropped too.
 */
export function normalizeAgentEnvPatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const pattern = entry.trim();
    if (!ENV_NAME_PATTERN.test(pattern) && !ENV_PREFIX_PATTERN.test(pattern)) continue;
    if (pattern.toUpperCase().startsWith("PAPERCLIP_")) continue;
    seen.add(pattern);
  }
  return [...seen];
}

const policyStorage = new AsyncLocalStorage<AgentEnvPolicy>();

/**
 * Run `fn` with the policy resolved by the server for one agent run. Launch
 * paths read it from here, so no adapter threads it through its own config and
 * a harness switch keeps the agent's extension.
 */
export function runWithAgentEnvPolicy<T>(policy: AgentEnvPolicy, fn: () => T): T {
  return policyStorage.run(policy, fn);
}

export function resolveAgentEnvPatterns(
  policy?: AgentEnvPolicy | null,
  options: { omitHarnessDefaults?: boolean } = {},
): string[] {
  const active = policy ?? policyStorage.getStore() ?? {};
  let base = active.allowlist == null
    ? [...DEFAULT_AGENT_ENV_ALLOWLIST]
    : normalizeAgentEnvPatterns(active.allowlist);
  if (options.omitHarnessDefaults) {
    const harness = new Set(HARNESS_AGENT_ENV_ALLOWLIST);
    base = base.filter((pattern) => !harness.has(pattern));
  }
  return [...base, ...normalizeAgentEnvPatterns(active.inheritEnv)];
}

function compilePatterns(patterns: readonly string[]) {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const pattern of patterns) {
    const upper = pattern.toUpperCase();
    if (upper.endsWith("_*")) prefixes.push(upper.slice(0, -1));
    else exact.add(upper);
  }
  return (name: string) => {
    const upper = name.toUpperCase();
    return exact.has(upper) || prefixes.some((prefix) => upper.startsWith(prefix));
  };
}

/**
 * The part of the server environment an agent process may inherit. Pure: pass
 * `source` and `extraPatterns` explicitly in tests; at runtime they default to
 * `process.env` and the active run policy.
 */
export function selectInheritedAgentEnv(
  source: NodeJS.ProcessEnv = process.env,
  options: {
    policy?: AgentEnvPolicy | null;
    extraPatterns?: readonly string[];
    omitHarnessDefaults?: boolean;
  } = {},
): Record<string, string> {
  const allowed = compilePatterns([
    ...resolveAgentEnvPatterns(options.policy, { omitHarnessDefaults: options.omitHarnessDefaults }),
    ...normalizeAgentEnvPatterns(options.extraPatterns),
  ]);
  const selected: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (allowed(key)) selected[key] = value;
  }
  return selected;
}

/** Allow-listed server environment overlaid with the run's explicit env. */
export function buildAgentProcessEnv(
  explicitEnv: Record<string, string | undefined> = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...selectInheritedAgentEnv(source), ...explicitEnv };
}
