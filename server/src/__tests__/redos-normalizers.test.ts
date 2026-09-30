import { describe, expect, it } from "vitest";
import { normalizeSecretKey } from "../services/secrets.js";
import { deriveNameFromCwd } from "../services/projects.js";

// Both inputs froze the event loop before the fix (code-scanning alerts 37, 38).
function elapsedMs(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe("normalizeSecretKey", () => {
  it("trims dashes without backtracking", () => {
    const hostile = `a${"-".repeat(100_000)}b`;
    expect(elapsedMs(() => normalizeSecretKey(hostile))).toBeLessThan(1_000);
  });

  it("normalizes keys as before", () => {
    expect(normalizeSecretKey("  My API Key!! ")).toBe("my-api-key");
    expect(normalizeSecretKey("--a.b_c--")).toBe("a.b_c");
    expect(normalizeSecretKey("---")).toBe("");
  });
});

describe("deriveNameFromCwd", () => {
  it("strips trailing separators without backtracking", () => {
    const hostile = `a${"/".repeat(100_000)}b`;
    expect(elapsedMs(() => deriveNameFromCwd(hostile))).toBeLessThan(1_000);
  });

  it("derives names as before", () => {
    expect(deriveNameFromCwd("/home/me/project/")).toBe("project");
    expect(deriveNameFromCwd("C:\\work\\repo\\\\")).toBe("repo");
    expect(deriveNameFromCwd("///")).toBe("Local folder");
  });
});
