import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeCommandSupportsEffortFlag,
  probeClaudeCommandVersionDetailed,
  readClaudeCommandVersion,
  resetClaudeCliCapabilitiesCacheForTests,
} from "./cli-capabilities.js";

const directories: string[] = [];

afterEach(() => {
  resetClaudeCliCapabilitiesCacheForTests();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function slowClaude() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "paperclip-slow-claude-"));
  directories.push(cwd);
  const command = path.join(cwd, "claude");
  writeFileSync(command, `#!${process.execPath}\nsetTimeout(() => {
  console.log(process.argv.includes("--version") ? "2.1.284 (test CLI)" : "Usage: claude --effort <level>");
}, 1500);\n`);
  chmodSync(command, 0o755);
  return { runId: "capability-probe", command, target: null, cwd, env: {}, graceSec: 1 };
}

// This fixture is a real executable. Windows does not use POSIX shebang files.
describe.skipIf(process.platform === "win32")("Claude CLI capability probe budgets", () => {
  it("allows a slow version and effort probe with an unlimited run timeout", async () => {
    const input = { ...slowClaude(), timeoutSec: 0 };
    await expect(readClaudeCommandVersion(input)).resolves.toBe("2.1.284");
    await expect(claudeCommandSupportsEffortFlag(input)).resolves.toBe(true);
  }, 30_000);

  it("retains an explicit shorter positive timeout", async () => {
    const input = { ...slowClaude(), timeoutSec: 1 };
    await expect(readClaudeCommandVersion(input)).resolves.toBeNull();
    await expect(claudeCommandSupportsEffortFlag(input)).resolves.toBeNull();
  }, 30_000);
});

describe.skipIf(process.platform === "win32")("Claude CLI version probe outcome", () => {
  function fakeClaude(body: string) {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "paperclip-probe-claude-"));
    directories.push(cwd);
    const command = path.join(cwd, "claude");
    writeFileSync(command, `#!${process.execPath}\n${body}\n`);
    chmodSync(command, 0o755);
    return { runId: "probe-outcome", command, target: null, cwd, env: {}, timeoutSec: 1, graceSec: 1 };
  }

  it("reports the exit code and stderr of a failing probe", async () => {
    const input = fakeClaude(`console.error("DISK GUARD: host x has 6 GB free. Run not started."); process.exit(75);`);
    const probe = await probeClaudeCommandVersionDetailed(input);
    expect(probe.version).toBeNull();
    expect(probe.failure).toContain("exited with code 75");
    expect(probe.failure).toContain("DISK GUARD: host x has 6 GB free");
  });

  it("reports a timeout", async () => {
    const probe = await probeClaudeCommandVersionDetailed(fakeClaude(`setTimeout(() => {}, 10000);`));
    expect(probe).toEqual({ version: null, failure: expect.stringContaining("timed out after 1s") });
  }, 15_000);

  it("returns a real old version without a failure", async () => {
    const probe = await probeClaudeCommandVersionDetailed(fakeClaude(`console.log("2.1.100 (Claude Code)");`));
    expect(probe).toEqual({ version: "2.1.100", failure: null });
  });
});
