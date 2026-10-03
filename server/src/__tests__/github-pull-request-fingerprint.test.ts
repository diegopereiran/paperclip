import { describe, expect, it } from "vitest";
import {
  actionableFingerprintChange,
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

describe("fingerprint parsing", () => {
  it("round trips a valid fingerprint and drops a malformed one", () => {
    expect(parsePullRequestFingerprint(base)).toEqual(base);
    expect(parsePullRequestFingerprint({ ...base, state: "weird" })).toBeNull();
    expect(parsePullRequestFingerprint("nope")).toBeNull();
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
