import { describe, expect, it } from "vitest";
import {
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

describe("fingerprint parsing", () => {
  it("round trips a valid fingerprint and drops a malformed one", () => {
    expect(parsePullRequestFingerprint(base)).toEqual(base);
    expect(parsePullRequestFingerprint({ ...base, state: "weird" })).toBeNull();
    expect(parsePullRequestFingerprint("nope")).toBeNull();
  });

  it("keeps only well-formed keys", () => {
    const key = pullRequestStateKey({ owner: "Open", repo: "Repo", number: 3 });
    expect(key).toBe("open/repo#3");
    expect(parsePullRequestState({ [key]: base, "not a key": base, "a/b#1": { state: "open" } })).toEqual({ [key]: base });
  });
});
