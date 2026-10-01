export interface GitHubPullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

export const MAX_MONITOR_PULL_REQUESTS = 20;

const NAME = "[A-Za-z0-9_.-]+";
const PULL_REQUEST_URL = new RegExp(
  `https://(?:www\\.)?github\\.com/(${NAME})/(${NAME})/pull/(\\d+)(?=$|[/?#\\s)\\]>"'.,;])`,
  "gi",
);
const SHORT_REFERENCE = new RegExp(`(?<![\\w./#-])(${NAME})/(${NAME})#(\\d+)\\b`, "g");
const NAME_PATTERN = new RegExp(`^${NAME}$`);

function toRef(owner: string, repo: string, rawNumber: string | number): GitHubPullRequestRef | null {
  const number = typeof rawNumber === "number" ? rawNumber : Number(rawNumber);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  if (!NAME_PATTERN.test(owner) || !NAME_PATTERN.test(repo)) return null;
  return { owner: owner.toLowerCase(), repo: repo.toLowerCase(), number };
}

function pushUnique(target: GitHubPullRequestRef[], ref: GitHubPullRequestRef | null) {
  if (!ref || target.length >= MAX_MONITOR_PULL_REQUESTS) return;
  if (target.some((entry) => entry.owner === ref.owner && entry.repo === ref.repo && entry.number === ref.number)) {
    return;
  }
  target.push(ref);
}

/**
 * Extracts GitHub pull request coordinates from free text. Accepts
 * `https://github.com/{owner}/{repo}/pull/{N}` (optional `www.`, sub-path,
 * query or fragment) and `owner/repo#N`. Only coordinates are returned, never
 * the URL, so a query-string token cannot be stored.
 */
export function extractGitHubPullRequestRefs(...inputs: Array<string | null | undefined>): GitHubPullRequestRef[] {
  const refs: GitHubPullRequestRef[] = [];
  for (const input of inputs) {
    if (typeof input !== "string" || input.length === 0) continue;
    const matches: Array<{ index: number; ref: GitHubPullRequestRef | null }> = [];
    for (const match of input.matchAll(PULL_REQUEST_URL)) {
      matches.push({ index: match.index ?? 0, ref: toRef(match[1]!, match[2]!, match[3]!) });
    }
    for (const match of input.matchAll(SHORT_REFERENCE)) {
      matches.push({ index: match.index ?? 0, ref: toRef(match[1]!, match[2]!, match[3]!) });
    }
    matches.sort((left, right) => left.index - right.index);
    for (const match of matches) pushUnique(refs, match.ref);
  }
  return refs;
}

/** Validates stored coordinates (for example `monitor.pullRequests` read back from jsonb). */
export function parseGitHubPullRequestRefs(value: unknown): GitHubPullRequestRef[] {
  if (!Array.isArray(value)) return [];
  const refs: GitHubPullRequestRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { owner, repo, number } = entry as Record<string, unknown>;
    if (typeof owner !== "string" || typeof repo !== "string" || typeof number !== "number") continue;
    pushUnique(refs, toRef(owner, repo, number));
  }
  return refs;
}

export function mergeGitHubPullRequestRefs(...lists: GitHubPullRequestRef[][]): GitHubPullRequestRef[] {
  const merged: GitHubPullRequestRef[] = [];
  for (const list of lists) for (const ref of list) pushUnique(merged, ref);
  return merged;
}

export function formatGitHubPullRequestRef(ref: GitHubPullRequestRef) {
  return `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
}
