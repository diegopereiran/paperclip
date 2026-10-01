import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentProcessPolicyBindRoots, assertAgentProcessPolicyValid } from "../services/agent-process-policy-guard.js";

describe("agent process policy bind roots", () => {
  let tmp: string;
  let realHome: string;
  let realPaperclipHome: string;
  let linkedHome: string;
  let linkedPaperclipHome: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-process-policy-guard-")));
    realHome = path.join(tmp, "real-home");
    realPaperclipHome = path.join(tmp, "real-paperclip-home");
    fs.mkdirSync(path.join(realHome, "project"), { recursive: true });
    fs.mkdirSync(path.join(realPaperclipHome, "instances"), { recursive: true });
    linkedHome = path.join(tmp, "linked-home");
    linkedPaperclipHome = path.join(tmp, "linked-paperclip-home");
    fs.symlinkSync(realHome, linkedHome);
    fs.symlinkSync(realPaperclipHome, linkedPaperclipHome);
    vi.stubEnv("HOME", linkedHome);
    vi.stubEnv("PAPERCLIP_HOME", linkedPaperclipHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("includes the resolved target of a symlinked home and Paperclip home", () => {
    const roots = agentProcessPolicyBindRoots();
    expect(roots.homeDirs).toContain(realHome);
    expect(roots.paperclipDirs).toContain(realPaperclipHome);
  });

  it("rejects an entry naming the real target of a symlinked home or Paperclip home", () => {
    expect(() => assertAgentProcessPolicyValid({ filesystem: { rw: [realHome] } })).toThrow(/Invalid agent process policy/);
    expect(() => assertAgentProcessPolicyValid({ filesystem: { ro: [realPaperclipHome] } })).toThrow(/Invalid agent process policy/);
  });

  it("still accepts a narrower subpath under the symlinked home", () => {
    expect(assertAgentProcessPolicyValid({ filesystem: { rw: [path.join(realHome, "project")] } })).toEqual({
      filesystem: { rw: [path.join(realHome, "project")] },
    });
  });
});
