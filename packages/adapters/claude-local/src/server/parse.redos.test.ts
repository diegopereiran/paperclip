import { describe, expect, it } from "vitest";
import {
  extractClaudeLoginUrl,
  extractClaudeRetryNotBefore,
  isClaudePoisonedPreviousMessageIdError,
} from "./parse.js";

// Each input below froze the event loop for several seconds before the fix
// (code-scanning alerts 40-43). The bound is generous; a linear scan takes
// a few milliseconds.
function elapsedMs(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe("claude-local parse regexes stay linear on hostile stdout", () => {
  it("strips trailing punctuation from a login URL without backtracking", () => {
    const hostile = `http://x${".".repeat(100_000)}a`;
    expect(elapsedMs(() => extractClaudeLoginUrl(hostile))).toBeLessThan(1_000);
  });

  it("keeps extracting login URLs as before", () => {
    expect(extractClaudeLoginUrl("see https://example.com/path!!")).toBe("https://example.com/path");
    expect(extractClaudeLoginUrl("no url here")).toBeNull();
  });

  it("detects the poisoned previous_message_id error without backtracking", () => {
    const hostile = "diagnostics.previous_message_id ".repeat(20_000);
    expect(elapsedMs(() => isClaudePoisonedPreviousMessageIdError({ result: hostile }))).toBeLessThan(1_000);
  });

  it("keeps matching the poisoned previous_message_id error on one line only", () => {
    expect(isClaudePoisonedPreviousMessageIdError({
      result: "invalid_request: diagnostics.previous_message_id starts with `msg_` but was not found",
    })).toBe(true);
    expect(isClaudePoisonedPreviousMessageIdError({
      result: "diagnostics.previous_message_id\nstarts with `msg_`",
    })).toBe(false);
  });

  it("parses a usage reset time without backtracking on long lines", () => {
    const hostile = `${"extra usage resets aaaa ".repeat(10_000)}(`;
    expect(elapsedMs(() => extractClaudeRetryNotBefore({ stdout: hostile }))).toBeLessThan(1_000);
  });

  it("still finds a usage reset time on a normal line", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    expect(extractClaudeRetryNotBefore({ stdout: "You've hit your limit · resets 5pm (UTC)" }, now)).not.toBeNull();
  });
});
