import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import {
  WAKE_CONTEXT_CANDIDATE_VERSION,
  applyWakeContextCandidate,
  isWakeContextCandidateEnabled,
} from "./wake-context-candidate.js";
import { replayWakeContext, rebuildWakePrompts, type ReplayAdapter } from "./wake-context-replay.js";

const message = (id: string, authorType: "user" | "agent", body: string, createdByRunId: string | null = null) => ({
  id, authorType, authorId: authorType === "user" ? "user-1" : (createdByRunId === "run-peer" ? "agent-2" : "agent-1"), createdByRunId, body,
  createdAt: `2026-10-14T10:${id.padStart(3, "0")}:00.000Z`, updatedAt: `2026-10-14T10:${id.padStart(3, "0")}:00.000Z`,
  deleted: false, sourceTrust: null,
});

function fixture() {
  const messages = [
    message("01", "user", "Requirement: never push to upstream."),
    ...Array.from({ length: 14 }, (_, i) => message(String(i + 2).padStart(2, "0"), "agent", `agent status ${i} `.repeat(200), "run-x")),
    message("15b", "agent", "Peer finding: the format check fails on line 9.", "run-peer"),
    message("16", "user", "Please fix the format check."),
  ];
  const envelope: ExecutionContinuationEnvelope = {
    version: 1, companyId: "c1", issueId: "i1",
    trigger: { reason: "issue_commented", interactionId: "int-1", sourceRunId: null },
    originCommentIds: ["03"],
    objective: "Please fix the format check.",
    objectiveSource: { kind: "comment", id: "16", revision: messages[16].updatedAt },
    messages,
    humanResponses: [{ id: "int-1", kind: "request_confirmation", status: "accepted", resolvedByUserId: "u", resolvedAt: "2026-10-14T10:00:00.000Z", result: { outcome: "accepted" } }],
    interactionOutcomes: [{ id: "int-2", kind: "ask_user_questions", status: "answered", result: { a: 1 } }],
    completedWork: "pushed branch",
    completedActions: [{ runId: "r0", receiptId: "rc1", operationId: "op-merge", result: { merged: true } }],
    unresolvedInteractionIds: ["int-9"],
    coverage: { kind: "full_task_history", throughCommentId: "16", summaryThroughCommentId: null },
  };
  const wake = { reason: "issue_commented", comments: [messages[2]], commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 }, fallbackFetchNeeded: false, issue: { id: "i1", identifier: "X-1", title: "T", description: "Brief", status: "in_progress" } };
  return { envelope, context: { executionContinuation: envelope, paperclipWake: wake } as Record<string, unknown> };
}

describe("wake-context candidate flag", () => {
  it("is off unless runtimeConfig.wakeContextCandidate is true", () => {
    expect(isWakeContextCandidateEnabled(undefined)).toBe(false);
    expect(isWakeContextCandidateEnabled({})).toBe(false);
    expect(isWakeContextCandidateEnabled({ wakeContextCandidate: "yes" })).toBe(false);
    expect(isWakeContextCandidateEnabled({ wakeContextCandidate: true })).toBe(true);
  });

  it("leaves the baseline prompt without any candidate marker (flag off is byte-identical)", () => {
    const { envelope, context } = fixture();
    const baseline = rebuildWakePrompts(context, "agent-1").baseline;
    expect(baseline.version).toBeNull();
    expect(baseline.prompt).toBe(renderPaperclipWakePrompt({ ...(context.paperclipWake as object), executionContinuation: envelope }));
    expect(baseline.prompt).not.toContain("contextCandidate");
    expect(baseline.prompt).not.toContain("task_history_trimmed");
  });
});

describe("applyWakeContextCandidate", () => {
  it("elides old agent comments and records the version", () => {
    const { envelope } = fixture();
    const out = applyWakeContextCandidate(envelope, { ownAgentId: "agent-1" });
    expect(out.contextCandidate?.version).toBe(WAKE_CONTEXT_CANDIDATE_VERSION);
    expect(out.coverage.kind).toBe("task_history_trimmed");
    expect(out.messages.length).toBeLessThan(envelope.messages.length);
    const elided = out.contextCandidate!.elidedMessages;
    expect(elided.length).toBeGreaterThan(0);
    expect(elided[0]).toMatchObject({ authorType: "agent", bodyBytes: expect.any(Number) });
    expect(out.messages.some((m) => m.id === elided[0].id)).toBe(false);
    expect(envelope.messages).toHaveLength(17);
  });

  it("keeps requirements, decisions, sources and committed actions", () => {
    const { envelope } = fixture();
    const out = applyWakeContextCandidate(envelope, { ownAgentId: "agent-1" });
    const ids = out.messages.map((m) => m.id);
    expect(out.objective).toBe(envelope.objective);
    expect(out.objectiveSource).toEqual(envelope.objectiveSource);
    expect(ids).toContain("01");
    expect(ids).toContain("16");
    expect(ids).toContain("03");
    expect(out.originCommentIds).toEqual(["03"]);
    expect(out.humanResponses).toEqual(envelope.humanResponses);
    expect(out.unresolvedInteractionIds).toEqual(["int-9"]);
    expect(out.interactionOutcomes).toEqual(envelope.interactionOutcomes);
    expect(out.completedActions).toEqual(envelope.completedActions);
    expect(out.completedWork).toBe("pushed branch");
    const elidedIds = out.contextCandidate!.elidedMessages.map((m) => m.id);
    for (const dropped of envelope.messages.filter((m) => !ids.includes(m.id))) expect(elidedIds).toContain(dropped.id);
  });

  it("keeps the newest comments inline", () => {
    const { envelope } = fixture();
    const ids = applyWakeContextCandidate(envelope, { ownAgentId: "agent-1" }).messages.map((m) => m.id);
    for (const m of envelope.messages.slice(-6)) expect(ids).toContain(m.id);
  });

  it("keeps other authors' comments, even old ones", () => {
    const { envelope } = fixture();
    const peer = envelope.messages.find((m) => m.authorId === "agent-2")!;
    const out = applyWakeContextCandidate({ ...envelope, messages: [peer, ...envelope.messages.filter((m) => m !== peer)] }, { ownAgentId: "agent-1", recentMessages: 1 });
    expect(out.messages.map((m) => m.id)).toContain(peer.id);
    expect(out.contextCandidate!.elidedMessages.every((m) => m.authorId === "agent-1")).toBe(true);
  });

  it("trims the resume delta with the same rule", () => {
    const { envelope } = fixture();
    const delta = { baseRunId: "r0", messages: [envelope.messages[5], envelope.messages[0]] };
    const out = applyWakeContextCandidate({ ...envelope, resumeDelta: delta }, { ownAgentId: "agent-1" });
    expect(out.resumeDelta?.messages.map((m) => m.id)).toEqual([envelope.messages[0].id]);
    expect(out.contextCandidate!.elidedMessages.map((m) => m.id)).toContain(envelope.messages[5].id);
  });

  it("does not mark coverage trimmed when nothing was dropped", () => {
    const { envelope } = fixture();
    const out = applyWakeContextCandidate({ ...envelope, messages: envelope.messages.slice(-3) }, { ownAgentId: "agent-1" });
    expect(out.coverage.kind).toBe("full_task_history");
    expect(out.contextCandidate?.elidedMessages).toEqual([]);
  });
});

describe("wake-context replay", () => {
  it("renders a smaller candidate prompt that still carries the kept ids", async () => {
    const { context } = fixture();
    const [base, cand] = await replayWakeContext({ recordedContext: context, agentId: "agent-1" });
    expect(base.version).toBeNull();
    expect(cand.version).toBe(WAKE_CONTEXT_CANDIDATE_VERSION);
    expect(cand.promptBytes).toBeLessThan(base.promptBytes);
    const prompts = rebuildWakePrompts(context, "agent-1");
    for (const needle of ["int-9", "op-merge", "Requirement: never push to upstream.", "Please fix the format check.", WAKE_CONTEXT_CANDIDATE_VERSION]) {
      expect(prompts.candidate.prompt).toContain(needle);
    }
  });

  it("tells the agent about elided comments only in the candidate prompt", () => {
    const prompts = rebuildWakePrompts(fixture().context, "agent-1");
    expect(prompts.candidate.prompt).toContain("except the comments listed in contextCandidate.elidedMessages");
    expect(prompts.baseline.prompt).toContain("History is complete through the coverage cursor. Prefer source messages");
    expect(prompts.baseline.prompt).not.toContain("elidedMessages");
  });

  it("rejects a context that was already trimmed", () => {
    const { envelope, context } = fixture();
    expect(() => rebuildWakePrompts({ ...context, executionContinuation: applyWakeContextCandidate(envelope, { ownAgentId: "agent-1" }) }, "agent-1")).toThrow("replay_context_already_candidate");
  });

  it("stubs writes: a child process write lands in the recorder and never reaches the network", async () => {
    const { context } = fixture();
    const realFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = (async () => { networkCalls += 1; throw new Error("network"); }) as typeof fetch;
    try {
      const adapter: ReplayAdapter = async (ctx) => {
        expect(Object.keys(ctx.env).sort()).toEqual(["GITHUB_API_URL", "PAPERCLIP_API_URL", "PAPERCLIP_REPLAY"]);
        const script = `Promise.all([fetch(process.env.GITHUB_API_URL + "/repos/o/r/pulls", {method:"POST", body:"{}"}),
          fetch(process.env.PAPERCLIP_API_URL + "/api/issues/1", {method:"PATCH", body:'{"status":"done"}'})])`;
        const status = await new Promise<number | null>((resolve) =>
          spawn(process.execPath, ["-e", script], { env: { ...ctx.env }, stdio: "ignore" }).on("close", resolve));
        expect(status).toBe(0);
        return { transcript: [`ran ${ctx.variant}`], inputTokens: Math.ceil(ctx.prompt.length / 4), outputTokens: 1 };
      };
      const reports = await replayWakeContext({ recordedContext: context, agentId: "agent-1", adapter });
      expect(networkCalls).toBe(0);
      for (const r of reports) {
        expect(r.writeAttempts.map((w) => `${w.method} ${w.url}`).sort()).toEqual(["PATCH /api/issues/1", "POST /repos/o/r/pulls"]);
        expect(r.run?.transcript).toEqual([`ran ${r.variant}`]);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
