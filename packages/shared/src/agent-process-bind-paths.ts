/**
 * Paths an agent process policy may never bind. Pure and free of Node imports
 * so the UI bundle can share it; the server adds the host-specific roots.
 */
export const STATIC_FORBIDDEN_BIND_ROOTS: readonly string[] = Object.freeze([
  "/run/postgresql",
  "/var/run/postgresql",
]);

export type AgentProcessBindRoots = {
  /** The server user's home directory. */
  homeDirs?: readonly string[];
  /** The Paperclip home and the instance root. */
  paperclipDirs?: readonly string[];
};

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 1 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

/** Lexical form of an absolute POSIX path, or null when it is not one. */
export function cleanAbsoluteBindPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > 4096 || value.includes("\0")) return null;
  if (!value.startsWith("/")) return null;
  const segments = value.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function equalsOrContains(candidate: string, root: string): boolean {
  const cleanRoot = trimTrailingSlashes(root);
  if (candidate === "/") return true;
  return cleanRoot === candidate || cleanRoot.startsWith(`${candidate}/`);
}

/**
 * Why `value` cannot be a read-write or read-only bind, or null when it can.
 * A path is rejected when it equals or contains (is an ancestor of) a
 * protected root; a narrower subpath of a root is allowed. This guards against
 * an administrator typo. It is not the confinement boundary.
 */
export function findUnsafeBindPath(value: unknown, roots: AgentProcessBindRoots = {}): string | null {
  if (typeof value !== "string" || !value.startsWith("/")) return "must be an absolute path";
  const candidate = cleanAbsoluteBindPath(value);
  if (!candidate) return "must be a clean absolute path with no '.' or '..' segments";
  if (candidate === "/") return "must not be the filesystem root or contain it";
  for (const root of STATIC_FORBIDDEN_BIND_ROOTS) {
    if (equalsOrContains(candidate, root)) return `must not equal or contain ${root}`;
  }
  for (const root of roots.homeDirs ?? []) {
    if (root && equalsOrContains(candidate, root)) return "must not equal or contain the server user's home directory";
  }
  for (const root of roots.paperclipDirs ?? []) {
    if (root && equalsOrContains(candidate, root)) return "must not equal or contain the Paperclip home or instance root";
  }
  return null;
}
