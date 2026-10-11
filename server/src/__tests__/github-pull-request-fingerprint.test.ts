import { describe, expect, it } from "vitest";
import {
  actionableFingerprintChange,
  advanceBaseline,
  changedFingerprintFields,
  parsePullRequestFingerprint,
  parsePullRequestState,
  pullRequestStateKey,
  summarizeCheckSuites,
  type PullRequestFingerprint,
} from "../services/github-pull-request-fingerprint.ts";

const base: PullRequestFingerprint = {
  headSha: "aaa",
  checkConclusion: "success",
  latestCommentId: 10,
  latestReviewId: 20,
  state: "open",
  mergeableState: "clean",
};

describe("summarizeCheckSuites", () => {
  it("reports none, pending, failure and success", () => {
    expect(summarizeCheckSuites([])).toBe("none");
    expect(summarizeCheckSuites([{ status: "in_progress" }, { status: "completed", conclusion: "success" }])).toBe("pending");
    expect(summarizeCheckSuites([{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "timed_out" }])).toBe("failure");
    expect(summarizeCheckSuites([{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }])).toBe("success");
  });
});

describe("changedFingerprintFields", () => {
  it.each([
    [{ headSha: "bbb" }, "head_sha"],
    [{ checkConclusion: "failure" as const }, "check_conclusion"],
    [{ latestCommentId: 11 }, "comment"],
    [{ latestReviewId: 21 }, "review"],
    [{ state: "merged" as const }, "state"],
    [{ mergeableState: "dirty" }, "mergeable_state"],
  ])("detects %j as %s", (patch, field) => {
    expect(changedFingerprintFields(base, { ...base, ...patch })).toEqual([field]);
  });

  it("counts a comment or review only when its id grows", () => {
    expect(changedFingerprintFields(base, { ...base, latestCommentId: null })).toEqual([]);
    expect(changedFingerprintFields(base, { ...base, latestCommentId: 9 })).toEqual([]);
    expect(changedFingerprintFields(base, { ...base, latestReviewId: null })).toEqual([]);
    expect(changedFingerprintFields(base, { ...base, latestReviewId: 19 })).toEqual([]);
    expect(changedFingerprintFields({ ...base, latestCommentId: null }, { ...base, latestCommentId: 1 })).toEqual(["comment"]);
  });

  it("reports no change for an identical fingerprint", () => {
    expect(changedFingerprintFields(base, { ...base })).toEqual([]);
  });

  it("ignores mergeable state while GitHub has not computed it", () => {
    expect(changedFingerprintFields(base, { ...base, mergeableState: null })).toEqual([]);
    expect(changedFingerprintFields({ ...base, mergeableState: null }, base)).toEqual([]);
  });
});

describe("actionableFingerprintChange", () => {
  const own = { ownLogin: "bot" };
  it.each([
    [{ state: "merged" as const }],
    [{ state: "closed" as const }],
    [{ headSha: "bbb" }],
    [{ checkConclusion: "failure" as const }],
    [{ latestReviewId: 21 }],
    [{ latestCommentId: 11, latestCommentAuthor: "human" }],
    [{ mergeableState: "dirty" }],
    [{ mergeableState: "behind" }],
  ])("wakes for %j", (patch) => {
    expect(actionableFingerprintChange(base, { ...base, ...patch }, own)).toHaveLength(1);
  });

  it("wakes for check success and mergeable clean", () => {
    expect(actionableFingerprintChange({ ...base, checkConclusion: "pending" }, base, own)).toEqual(["check_conclusion"]);
    expect(actionableFingerprintChange({ ...base, mergeableState: "blocked" }, base, own)).toEqual(["mergeable_state"]);
  });

  it.each([
    [{ checkConclusion: "pending" as const }],
    [{ checkConclusion: "none" as const }],
    [{ mergeableState: "blocked" }],
    [{ mergeableState: "unstable" }],
    [{ mergeableState: "has_hooks" }],
    [{ mergeableState: "draft" }],
    [{ latestCommentId: 11, latestCommentAuthor: "Bot" }],
  ])("stays quiet for %j", (patch) => {
    expect(actionableFingerprintChange(base, { ...base, ...patch }, own)).toEqual([]);
  });

  it("treats a comment as actionable when the own login or author is unknown", () => {
    const next = { ...base, latestCommentId: 11, latestCommentAuthor: "bot" };
    expect(actionableFingerprintChange(base, next, { ownLogin: null })).toEqual(["comment"]);
    expect(actionableFingerprintChange(base, { ...next, latestCommentAuthor: null }, own)).toEqual(["comment"]);
  });

  it("lists only the actionable fields of a mixed change", () => {
    const next = { ...base, headSha: "bbb", checkConclusion: "pending" as const, mergeableState: "blocked" };
    expect(actionableFingerprintChange(base, next, own)).toEqual(["head_sha"]);
  });
});

describe("actionableFingerprintChange: settled states only", () => {
  const own = { ownLogin: "Bot" };
  const ownPush = { headSha: "bbb", headAuthorLogin: "bot" };

  it("skips a head pushed by the own token while its checks are pending or absent", () => {
    for (const checkConclusion of ["pending", "none"] as const) {
      expect(actionableFingerprintChange(base, { ...base, ...ownPush, checkConclusion }, own)).toEqual([]);
    }
  });

  it("wakes for an own-token head once its checks settle", () => {
    expect(actionableFingerprintChange(base, { ...base, ...ownPush }, own)).toEqual(["head_sha"]);
    expect(
      actionableFingerprintChange(base, { ...base, ...ownPush, checkConclusion: "failure" }, own),
    ).toEqual(["head_sha", "check_conclusion"]);
  });

  it("still wakes for a head from someone else, an unknown author or an unresolved own login", () => {
    const pending = { ...base, headSha: "bbb", checkConclusion: "pending" as const };
    expect(actionableFingerprintChange(base, { ...pending, headAuthorLogin: "human" }, own)).toEqual(["head_sha"]);
    expect(actionableFingerprintChange(base, { ...pending, headAuthorLogin: null }, own)).toEqual(["head_sha"]);
    expect(actionableFingerprintChange(base, { ...pending, headAuthorLogin: "bot" }, { ownLogin: null })).toEqual(["head_sha"]);
  });

  it("skips behind and clean while the checks are pending", () => {
    const pending = { ...base, checkConclusion: "pending" as const };
    expect(actionableFingerprintChange(base, { ...pending, mergeableState: "behind" }, own)).toEqual([]);
    expect(actionableFingerprintChange({ ...base, mergeableState: "blocked" }, pending, own)).toEqual([]);
    expect(actionableFingerprintChange(base, { ...pending, mergeableState: "dirty" }, own)).toEqual(["mergeable_state"]);
  });

  it("skips behind and green while another pull request holds the review slot", () => {
    const busy = { ...base, reviewSlotBusy: true };
    expect(actionableFingerprintChange(base, { ...busy, mergeableState: "behind" }, own)).toEqual([]);
    expect(
      actionableFingerprintChange({ ...base, checkConclusion: "pending" }, { ...busy, mergeableState: "blocked" }, own),
    ).toEqual([]);
    expect(actionableFingerprintChange({ ...base, checkConclusion: "pending" }, busy, own)).toEqual([]);
  });

  it("wakes when the slot is free, or the pull request is clean and approved", () => {
    const free = { ...base, reviewSlotBusy: false };
    expect(actionableFingerprintChange({ ...base, checkConclusion: "pending" }, free, own)).toEqual(["check_conclusion"]);
    const approved = { ...base, reviewSlotBusy: true, approved: true };
    expect(actionableFingerprintChange({ ...base, checkConclusion: "pending" }, approved, own)).toEqual(["check_conclusion"]);
    expect(
      actionableFingerprintChange(base, { ...approved, mergeableState: "behind" }, own),
    ).toEqual([]);
  });

  it("keeps waking for a check failure and a dirty branch under a busy slot", () => {
    const busy = { ...base, reviewSlotBusy: true };
    expect(actionableFingerprintChange(base, { ...busy, checkConclusion: "failure" }, own)).toEqual(["check_conclusion"]);
    expect(actionableFingerprintChange(base, { ...busy, mergeableState: "dirty" }, own)).toEqual(["mergeable_state"]);
  });
});

describe("advanceBaseline", () => {
  it("keeps a deferred field at its stored value so the later change still wakes", () => {
    const stored = { ...base, checkConclusion: "pending" as const };
    const current = { ...base, reviewSlotBusy: true };
    const next = advanceBaseline(stored, current, { ownLogin: null });
    expect(next.checkConclusion).toBe("pending");
    expect(actionableFingerprintChange(next, { ...current, reviewSlotBusy: false }, { ownLogin: null })).toEqual([
      "check_conclusion",
    ]);
  });

  it("advances every other field and keeps ids the poll window dropped", () => {
    const next = advanceBaseline(base, { ...base, latestCommentId: null, latestReviewId: null, mergeableState: null }, {
      ownLogin: null,
    });
    expect(next).toMatchObject({ latestCommentId: 10, latestReviewId: 20, mergeableState: "clean" });
    expect(advanceBaseline(base, { ...base, headSha: "ccc" }, { ownLogin: null }).headSha).toBe("ccc");
  });
});

describe("fingerprint parsing", () => {
  it("round trips a valid fingerprint and drops a malformed one", () => {
    expect(parsePullRequestFingerprint(base)).toEqual(base);
    expect(parsePullRequestFingerprint({ ...base, state: "weird" })).toBeNull();
    expect(parsePullRequestFingerprint("nope")).toBeNull();
    const extended = { ...base, headAuthorLogin: "bot", reviewSlotBusy: true, approved: false };
    expect(parsePullRequestFingerprint(extended)).toEqual(extended);
  });

  it("drops a key with a dot-only owner or repository", () => {
    expect(parsePullRequestState({ "../orgs#5": base, "o/..#5": base, "o/r#5": base })).toEqual({ "o/r#5": base });
  });

  it("keeps only well-formed keys", () => {
    const key = pullRequestStateKey({ owner: "Open", repo: "Repo", number: 3 });
    expect(key).toBe("open/repo#3");
    expect(parsePullRequestState({ [key]: base, "not a key": base, "a/b#1": { state: "open" } })).toEqual({ [key]: base });
  });
});
