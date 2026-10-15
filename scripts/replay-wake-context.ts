/**
 * Offline wake-context comparison. Reads a recorded run context (JSON with
 * `executionContinuation` and `paperclipWake`) and prints baseline vs candidate
 * prompt size. Calls no model and no API. Run with:
 * pnpm --filter @paperclipai/server exec tsx ../scripts/replay-wake-context.ts <context.json> <agent-id>
 */
import { readFileSync } from "node:fs";
import { replayWakeContext } from "../server/src/services/wake-context-replay.js";

const [file, agentId] = process.argv.slice(2);
if (!file || !agentId) {
  console.error("usage: replay-wake-context.ts <recorded-context.json> <agent-id>");
  process.exit(2);
}
const reports = await replayWakeContext({ recordedContext: JSON.parse(readFileSync(file, "utf8")), agentId });
console.log(JSON.stringify(reports.map(({ run: _run, writeAttempts, ...rest }) => ({ ...rest, writeAttempts: writeAttempts.length })), null, 2));
