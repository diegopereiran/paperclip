import { isValidGitHubName } from "./github-pull-request-refs.js";

export type PullRequestCheckConclusion = "none" | "pending" | "success" | "failure";
export type PullRequestFingerprintState = "open" | "closed" | "merged";

export interface PullRequestFingerprint {
  headSha: string | null;
  checkConclusion: PullRequestCheckConclusion;
  latestCommentId: number | null;
  /** Login of the author of the latest comment; `null` when unknown (older baselines, deleted users). */
  latestCommentAuthor?: string | null;
  /** Id of the latest bot issue comment (CI, coverage, review bot); absent in baselines stored before it existed. */
  latestBotCommentId?: number | null;
  latestReviewId: number | null;
  state: PullRequestFingerprintState;
  /** `null` while GitHub has not computed it yet (`unknown`); a `null` side never counts as a change. */
  mergeableState: string | null;
  /** Login of the head commit's author; set only when the poller saw the head change. `null` when unknown. */
  headAuthorLogin?: string | null;
  /** Another open pull request holds the configured review-slot label while this one does not. */
  reviewSlotBusy?: boolean;
  /** The latest review of at least one reviewer approves and none of them requests changes. */
  approved?: boolean;
}

export type PullRequestFingerprintField =
  | "head_sha"
  | "check_conclusion"
  | "comment"
  | "bot_comment"
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
    ...(boundedString(raw.latestCommentAuthor) ? { latestCommentAuthor: boundedString(raw.latestCommentAuthor) } : {}),
    ...(raw.latestBotCommentId !== undefined ? { latestBotCommentId: idOrNull(raw.latestBotCommentId) } : {}),
    latestReviewId: idOrNull(raw.latestReviewId),
    state: raw.state as PullRequestFingerprintState,
    mergeableState: boundedString(raw.mergeableState),
    ...(boundedString(raw.headAuthorLogin) ? { headAuthorLogin: boundedString(raw.headAuthorLogin) } : {}),
    ...(typeof raw.reviewSlotBusy === "boolean" ? { reviewSlotBusy: raw.reviewSlotBusy } : {}),
    ...(typeof raw.approved === "boolean" ? { approved: raw.approved } : {}),
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
  // A baseline stored before bot comments were tracked has no value to compare with.
  if (previous.latestBotCommentId !== undefined && idGrew(previous.latestBotCommentId, current.latestBotCommentId ?? null)) {
    changed.push("bot_comment");
  }
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

const ACTIONABLE_MERGEABLE_STATES = new Set(["behind", "dirty", "clean"]);
/** Mergeable states that only matter once the checks have settled and the PR can move. */
const SETTLED_MERGEABLE_STATES = new Set(["behind", "clean"]);

function isSettled(fingerprint: PullRequestFingerprint) {
  return fingerprint.checkConclusion === "success" || fingerprint.checkConclusion === "failure";
}

/** The PR waits for the review slot, unless GitHub already calls it mergeable and a reviewer approved it. */
function waitsForReviewSlot(fingerprint: PullRequestFingerprint) {
  return fingerprint.reviewSlotBusy === true && !(fingerprint.mergeableState === "clean" && fingerprint.approved === true);
}

function isOwnHead(current: PullRequestFingerprint, ownLogin: string | null) {
  const author = current.headAuthorLogin?.toLowerCase() ?? null;
  return ownLogin !== null && author !== null && author === ownLogin;
}

export interface FingerprintChangeEvaluation {
  /** Fields worth waking for. */
  actionable: PullRequestFingerprintField[];
  /** Fields that may matter later (the PR cannot move yet): the baseline must keep their old value. */
  deferred: PullRequestFingerprintField[];
}

/**
 * Sorts the changed fields into `actionable`, `deferred` and noise (everything else). Mirrors `actionable()` in
 * the host script `pr_event_bridge.py`: transitions to `pending`, `blocked`, `unstable` and the like are noise.
 * A bot comment, a head pushed by the own token, `behind` and green wake only once the checks have settled and the review slot
 * is not held by another PR. `ownLogin` is the company token's own GitHub login; `null` (unresolved) fails open:
 * every new comment and every head wakes.
 */
export function evaluateFingerprintChange(
  previous: PullRequestFingerprint,
  current: PullRequestFingerprint,
  opts: { ownLogin: string | null },
): FingerprintChangeEvaluation {
  const ownLogin = opts.ownLogin?.toLowerCase() ?? null;
  const actionable: PullRequestFingerprintField[] = [];
  const deferred: PullRequestFingerprintField[] = [];
  const blockedFromMoving = waitsForReviewSlot(current);
  for (const field of changedFingerprintFields(previous, current)) {
    switch (field) {
      case "state":
      case "review":
        actionable.push(field);
        break;
      case "head_sha":
        if (!isOwnHead(current, ownLogin)) actionable.push(field);
        else if (isSettled(current)) (current.checkConclusion === "success" && blockedFromMoving ? deferred : actionable).push(field);
        break;
      case "check_conclusion":
        if (current.checkConclusion === "failure") actionable.push(field);
        else if (current.checkConclusion === "success") (blockedFromMoving ? deferred : actionable).push(field);
        break;
      case "mergeable_state":
        if (current.mergeableState === null || !ACTIONABLE_MERGEABLE_STATES.has(current.mergeableState)) break;
        if (SETTLED_MERGEABLE_STATES.has(current.mergeableState) && (current.checkConclusion === "pending" || blockedFromMoving)) {
          deferred.push(field);
        } else {
          actionable.push(field);
        }
        break;
      case "bot_comment":
        // A bot comment (placeholder, CI or coverage note, or a review bot's verdict) folds into the wake for
        // the checks settling; one posted after the checks settled is a verdict and wakes on its own.
        (current.checkConclusion === "pending" ? deferred : actionable).push(field);
        break;
      case "comment": {
        const author = current.latestCommentAuthor?.toLowerCase() ?? null;
        if (ownLogin === null || author === null || author !== ownLogin) actionable.push(field);
        break;
      }
    }
  }
  return { actionable, deferred };
}

export function actionableFingerprintChange(
  previous: PullRequestFingerprint,
  current: PullRequestFingerprint,
  opts: { ownLogin: string | null },
): PullRequestFingerprintField[] {
  return evaluateFingerprintChange(previous, current, opts).actionable;
}

/**
 * The baseline to store when nothing is woken: the current data, except that ids the poll window dropped keep
 * their stored value and deferred fields keep theirs, so the change still shows once the PR can move.
 */
export function advanceBaseline(
  stored: PullRequestFingerprint,
  current: PullRequestFingerprint,
  opts: { ownLogin: string | null },
): PullRequestFingerprint {
  const { deferred } = evaluateFingerprintChange(stored, current, opts);
  return {
    ...current,
    headSha: deferred.includes("head_sha") ? stored.headSha : current.headSha,
    checkConclusion: deferred.includes("check_conclusion") ? stored.checkConclusion : current.checkConclusion,
    latestCommentId: current.latestCommentId ?? stored.latestCommentId,
    latestCommentAuthor: current.latestCommentId === null ? stored.latestCommentAuthor ?? null : current.latestCommentAuthor,
    latestBotCommentId: deferred.includes("bot_comment")
      ? stored.latestBotCommentId
      : current.latestBotCommentId ?? stored.latestBotCommentId ?? null,
    latestReviewId: current.latestReviewId ?? stored.latestReviewId,
    mergeableState: deferred.includes("mergeable_state")
      ? stored.mergeableState
      : current.mergeableState ?? stored.mergeableState,
  };
}
