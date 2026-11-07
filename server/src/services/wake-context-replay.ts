import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import { applyWakeContextCandidate, WAKE_CONTEXT_CANDIDATE_VERSION } from "./wake-context-candidate.js";

export type ReplayVariant = "baseline" | "candidate";

export interface ReplayWriteAttempt {
  url: string;
  method: string;
  body: string | null;
}

/**
 * Everything an adapter run in replay mode may touch. The environment is built
 * from scratch: no API key, no token, and the Paperclip and GitHub API URLs
 * point at a loopback recorder that answers 200 and records the request. A
 * child process that honours those URLs writes into the recorder, never to a
 * real service; one that hardcodes a host still has no credential to write with.
 */
export interface ReplayRunContext {
  variant: ReplayVariant;
  prompt: string;
  env: Readonly<Record<string, string>>;
}

export interface ReplayAdapterResult {
  transcript: string[];
  inputTokens: number;
  outputTokens: number;
}

export type ReplayAdapter = (ctx: ReplayRunContext) => Promise<ReplayAdapterResult>;

export interface ReplayVariantReport {
  variant: ReplayVariant;
  version: string | null;
  promptBytes: number;
  estimatedTokens: number;
  writeAttempts: ReplayWriteAttempt[];
  run: ReplayAdapterResult | null;
}

/** Rough size proxy for offline comparison; real token counts come from the adapter run. */
export const estimateTokens = (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 4);

function withEnvelope(wake: Record<string, unknown>, envelope: ExecutionContinuationEnvelope) {
  return { ...wake, executionContinuation: envelope };
}

/** Render the prompt a recorded wake produced (baseline) and the one the candidate would produce. */
export function rebuildWakePrompts(recordedContext: Record<string, unknown>, ownAgentId: string): Record<ReplayVariant, { prompt: string; version: string | null }> {
  const wake = (recordedContext.paperclipWake ?? {}) as Record<string, unknown>;
  const envelope = (recordedContext.executionContinuation ?? wake.executionContinuation) as ExecutionContinuationEnvelope | undefined;
  if (!envelope || envelope.version !== 1) throw new Error("replay_context_missing_continuation");
  if (envelope.contextCandidate) throw new Error("replay_context_already_candidate");
  const candidate = applyWakeContextCandidate(envelope, { ownAgentId });
  return {
    baseline: { prompt: renderPaperclipWakePrompt(withEnvelope(wake, envelope)), version: null },
    candidate: { prompt: renderPaperclipWakePrompt(withEnvelope(wake, candidate)), version: WAKE_CONTEXT_CANDIDATE_VERSION },
  };
}

async function startWriteRecorder() {
  const attempts: ReplayWriteAttempt[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      attempts.push({ url: req.url ?? "", method: (req.method ?? "GET").toUpperCase(), body: body || null });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, attempts, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

export async function replayWakeContext(input: {
  recordedContext: Record<string, unknown>;
  /** The agent whose own older comments the candidate elides. */
  agentId: string;
  /** Omit to compare sizes only. */
  adapter?: ReplayAdapter;
}): Promise<ReplayVariantReport[]> {
  const prompts = rebuildWakePrompts(input.recordedContext, input.agentId);
  const reports: ReplayVariantReport[] = [];
  for (const variant of ["baseline", "candidate"] as const) {
    const { prompt, version } = prompts[variant];
    const recorder = await startWriteRecorder();
    try {
      const ctx: ReplayRunContext = {
        variant,
        prompt,
        env: Object.freeze({ PAPERCLIP_REPLAY: "1", PAPERCLIP_API_URL: recorder.url, GITHUB_API_URL: recorder.url }),
      };
      const run = input.adapter ? await input.adapter(ctx) : null;
      reports.push({
        variant,
        version,
        promptBytes: Buffer.byteLength(prompt, "utf8"),
        estimatedTokens: estimateTokens(prompt),
        writeAttempts: recorder.attempts,
        run,
      });
    } finally {
      await recorder.close();
    }
  }
  return reports;
}
