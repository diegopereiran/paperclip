import { describe, expect, it } from "vitest";
import {
  extractGitHubPullRequestRefs,
  formatGitHubPullRequestRef,
  parseGitHubPullRequestRefs,
} from "../services/github-pull-request-refs.ts";

describe("extractGitHubPullRequestRefs", () => {
  it.each([
    ["https://github.com/Open-Astro/AlpacaBridge/pull/42", { owner: "open-astro", repo: "alpacabridge", number: 42 }],
    ["https://www.github.com/o/r/pull/7", { owner: "o", repo: "r", number: 7 }],
    ["https://github.com/o/r/pull/7/files", { owner: "o", repo: "r", number: 7 }],
    ["https://github.com/o/r/pull/7/commits/abc123", { owner: "o", repo: "r", number: 7 }],
    ["https://github.com/o/r/pull/7#issuecomment-123", { owner: "o", repo: "r", number: 7 }],
    ["https://github.com/o/r/pull/7?token=secret&x=1", { owner: "o", repo: "r", number: 7 }],
    ["Waiting on https://github.com/o/r/pull/7.", { owner: "o", repo: "r", number: 7 }],
    ["(see https://github.com/o/r/pull/7)", { owner: "o", repo: "r", number: 7 }],
    ["Owner/Repo#19", { owner: "owner", repo: "repo", number: 19 }],
    ["watch my-org/my.repo_x#3 for CI", { owner: "my-org", repo: "my.repo_x", number: 3 }],
  ])("parses %s", (text, expected) => {
    expect(extractGitHubPullRequestRefs(text)).toEqual([expected]);
  });

  it.each([
    "https://github.com/o/r/issues/5",
    "https://github.com/o/r/pull/abc",
    "https://github.com/o/r/pull/5abc",
    "https://github.com/o/r/pull/0",
    "https://gitlab.com/o/r/pull/5",
    "https://github.com.evil.example/o/r/pull/5",
    "https://github.com@evil.example/o/r/pull/5",
    "https://evil.example/https://x/github.com-o/r/pull/x",
    "https://gitlab.com/o/r#5",
    "https://github.com/o/r#5",
    "https://github.com/o/r/pull/99999999999999999999",
    "r#5",
    "o/r#",
    "o/r#5x",
    "#5",
    "",
  ])("rejects %s", (text) => {
    expect(extractGitHubPullRequestRefs(text)).toEqual([]);
  });

  it("never keeps the URL, its query string or a token", () => {
    const refs = extractGitHubPullRequestRefs("https://github.com/o/r/pull/7?token=secret-value");
    expect(JSON.stringify(refs)).not.toContain("secret-value");
    expect(JSON.stringify(refs)).not.toContain("http");
    expect(Object.keys(refs[0]!).sort()).toEqual(["number", "owner", "repo"]);
  });

  it("dedupes across inputs, skips nullish inputs and keeps first-seen order", () => {
    expect(
      extractGitHubPullRequestRefs(
        "https://github.com/O/R/pull/2 and o/r#2 and o/r#1",
        null,
        undefined,
        "x/y#9",
      ),
    ).toEqual([
      { owner: "o", repo: "r", number: 2 },
      { owner: "o", repo: "r", number: 1 },
      { owner: "x", repo: "y", number: 9 },
    ]);
  });

  it("caps the number of references per monitor", () => {
    const text = Array.from({ length: 50 }, (_, index) => `o/r#${index + 1}`).join(" ");
    expect(extractGitHubPullRequestRefs(text)).toHaveLength(20);
  });
});

describe("parseGitHubPullRequestRefs", () => {
  it("accepts only well-formed coordinate objects and lower-cases them", () => {
    expect(
      parseGitHubPullRequestRefs([
        { owner: "Open", repo: "Repo", number: 3 },
        { owner: "o", repo: "r", number: 0 },
        { owner: "o", repo: "r", number: "4" },
        { owner: "o/x", repo: "r", number: 5 },
        { owner: "o", repo: "r", number: 3, url: "https://github.com/o/r/pull/3?token=x" },
        "o/r#1",
        null,
      ]),
    ).toEqual([
      { owner: "open", repo: "repo", number: 3 },
      { owner: "o", repo: "r", number: 3 },
    ]);
  });

  it("returns an empty list for non-arrays", () => {
    expect(parseGitHubPullRequestRefs(undefined)).toEqual([]);
    expect(parseGitHubPullRequestRefs("o/r#1")).toEqual([]);
  });
});

describe("formatGitHubPullRequestRef", () => {
  it("formats owner/repo#N", () => {
    expect(formatGitHubPullRequestRef({ owner: "O", repo: "R", number: 8 })).toBe("o/r#8");
  });
});
