/**
 * Offline wake-context comparison. Reads a recorded run context (JSON with
 * `executionContinuation` and `paperclipWake`) and prints baseline vs candidate
 * prompt size. Calls no model and no API. Run with:
 * pnpm --filter @paperclipai/server exec tsx ../scripts/replay-wake-context.ts <context.json> <agent-id>
 */
import { readFileSync } from "node:fs";
import { applyWakeContextCandidate } from "../server/src/services/wake-context-candidate.js";
import { replayWakeContext } from "../server/src/services/wake-context-replay.js";

const [file, agentId] = process.argv.slice(2);
if (!file || !agentId) {
  console.error("usage: replay-wake-context.ts <recorded-context.json> <agent-id>");
  process.exit(2);
}
const recordedContext = JSON.parse(readFileSync(file, "utf8"));
const reports = await replayWakeContext({ recordedContext, agentId });
console.log(JSON.stringify(reports.map(({ run: _run, writeAttempts, ...rest }) => ({ ...rest, writeAttempts: writeAttempts.length })), null, 2));

// Kept-set check: every comment missing from the candidate must be listed by id in elidedMessages.
const envelope = recordedContext.executionContinuation ?? recordedContext.paperclipWake?.executionContinuation;
const candidate = applyWakeContextCandidate(envelope, { ownAgentId: agentId });
const stubIds = new Set((candidate.contextCandidate?.elidedMessages ?? []).map((m: { id: string }) => m.id));
const kept = new Set(candidate.messages.map((m: { id: string }) => m.id));
const unaccounted = envelope.messages.filter((m: { id: string }) => !kept.has(m.id) && !stubIds.has(m.id));
console.log(JSON.stringify({ comments: envelope.messages.length, elided: stubIds.size, unaccounted: unaccounted.length }));
if (unaccounted.length > 0) process.exit(1);
