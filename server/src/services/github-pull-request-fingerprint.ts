import { isValidGitHubName } from "./github-pull-request-refs.js";

export type PullRequestCheckConclusion = "none" | "pending" | "success" | "failure";
export type PullRequestFingerprintState = "open" | "closed" | "merged";

export interface PullRequestFingerprint {
  headSha: string | null;
  checkConclusion: PullRequestCheckConclusion;
  latestCommentId: number | null;
  latestReviewId: number | null;
  state: PullRequestFingerprintState;
  /** `null` while GitHub has not computed it yet (`unknown`); a `null` side never counts as a change. */
  mergeableState: string | null;
}

export type PullRequestFingerprintField =
  | "head_sha"
  | "check_conclusion"
  | "comment"
  | "review"
  | "state"
  | "mergeable_state";

const CHECK_CONCLUSIONS = new Set<string>(["none", "pending", "success", "failure"]);
const STATES = new Set<string>(["open", "closed", "merged"]);
const MAX_FIELD_LENGTH = 100;
const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);

export function pullRequestStateKey(ref: { owner: string; repo: string; number: number }) {
  return `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
}

/** Reduces the check suites of one commit to a single conclusion. */
export function summarizeCheckSuites(
  suites: ReadonlyArray<{ status?: unknown; conclusion?: unknown }>,
): PullRequestCheckConclusion {
  if (suites.length === 0) return "none";
  if (suites.some((suite) => suite.status !== "completed")) return "pending";
  if (suites.some((suite) => typeof suite.conclusion === "string" && FAILING_CONCLUSIONS.has(suite.conclusion))) {
    return "failure";
  }
  return "success";
}

function boundedString(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH ? value : null;
}

function idOrNull(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Validates a fingerprint read back from jsonb; anything malformed is dropped so it becomes a new baseline. */
export function parsePullRequestFingerprint(value: unknown): PullRequestFingerprint | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.state !== "string" || !STATES.has(raw.state)) return null;
  if (typeof raw.checkConclusion !== "string" || !CHECK_CONCLUSIONS.has(raw.checkConclusion)) return null;
  return {
    headSha: boundedString(raw.headSha),
    checkConclusion: raw.checkConclusion as PullRequestCheckConclusion,
    latestCommentId: idOrNull(raw.latestCommentId),
    latestReviewId: idOrNull(raw.latestReviewId),
    state: raw.state as PullRequestFingerprintState,
    mergeableState: boundedString(raw.mergeableState),
  };
}

export function parsePullRequestState(value: unknown): Record<string, PullRequestFingerprint> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const parsed: Record<string, PullRequestFingerprint> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const match = /^([a-z0-9_.-]+)\/([a-z0-9_.-]+)#\d+$/.exec(key);
    if (!match || !isValidGitHubName(match[1]!) || !isValidGitHubName(match[2]!)) continue;
    const fingerprint = parsePullRequestFingerprint(entry);
    if (fingerprint) parsed[key] = fingerprint;
  }
  return parsed;
}

/** Comment and review ids only grow; a missing or smaller id means the poll window moved, not a new entry. */
function idGrew(previous: number | null, current: number | null) {
  if (current === null) return false;
  return previous === null || current > previous;
}

export function changedFingerprintFields(
  previous: PullRequestFingerprint,
  current: PullRequestFingerprint,
): PullRequestFingerprintField[] {
  const changed: PullRequestFingerprintField[] = [];
  if (previous.headSha !== current.headSha) changed.push("head_sha");
  if (previous.checkConclusion !== current.checkConclusion) changed.push("check_conclusion");
  if (idGrew(previous.latestCommentId, current.latestCommentId)) changed.push("comment");
  if (idGrew(previous.latestReviewId, current.latestReviewId)) changed.push("review");
  if (previous.state !== current.state) changed.push("state");
  if (
    previous.mergeableState !== null &&
    current.mergeableState !== null &&
    previous.mergeableState !== current.mergeableState
  ) {
    changed.push("mergeable_state");
  }
  return changed;
}
