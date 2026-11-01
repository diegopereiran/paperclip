import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";

/** Recorded in the envelope so replays and ledgers can tell candidate from baseline. */
export const WAKE_CONTEXT_CANDIDATE_VERSION = "wake-context-candidate/v1";
/** Agent `runtimeConfig` key. Absent or anything but `true` leaves the wake payload untouched. */
export const WAKE_CONTEXT_CANDIDATE_CONFIG_KEY = "wakeContextCandidate";
/** Newest comments always kept inline, whoever wrote them. */
export const WAKE_CONTEXT_CANDIDATE_RECENT_MESSAGES = 6;

type Message = ExecutionContinuationEnvelope["messages"][number];

export function isWakeContextCandidateEnabled(runtimeConfig: unknown): boolean {
  return (
    !!runtimeConfig &&
    typeof runtimeConfig === "object" &&
    (runtimeConfig as Record<string, unknown>)[WAKE_CONTEXT_CANDIDATE_CONFIG_KEY] === true
  );
}

/**
 * Drop older comments the agent itself wrote from the inline history. Kept
 * inline: every comment by anyone else (humans, other agents, system), wake
 * origin comments, the objective's source comment, the agent's newest few
 * comments, and every non-message field (objective, interactions, human
 * responses, outcomes, completed actions). Dropped comments remain as id stubs
 * so the agent can fetch them. The same rule trims the resume delta, so a
 * resumed session is not sent the dropped bodies again.
 */
export function applyWakeContextCandidate(
  envelope: ExecutionContinuationEnvelope,
  options: { ownAgentId: string; recentMessages?: number },
): ExecutionContinuationEnvelope {
  const recent = options.recentMessages ?? WAKE_CONTEXT_CANDIDATE_RECENT_MESSAGES;
  const pinned = new Set<string>(envelope.originCommentIds);
  if (envelope.objectiveSource?.kind === "comment") pinned.add(envelope.objectiveSource.id);
  envelope.messages.slice(-recent).forEach((message) => pinned.add(message.id));
  const isOwnComment = (message: Message) => message.authorType === "agent" && message.authorId === options.ownAgentId && !message.deleted;
  const elide = (message: Message) => isOwnComment(message) && !pinned.has(message.id);
  const stubs = envelope.messages.filter(elide).map((message) => ({
    id: message.id,
    authorType: message.authorType,
    authorId: message.authorId,
    createdAt: message.createdAt,
    bodyBytes: Buffer.byteLength(message.body, "utf8"),
  }));
  return {
    ...envelope,
    messages: envelope.messages.filter((message) => !elide(message)),
    ...(envelope.resumeDelta
      ? { resumeDelta: { ...envelope.resumeDelta, messages: envelope.resumeDelta.messages.filter((message) => !elide(message)) } }
      : {}),
    contextCandidate: {
      version: WAKE_CONTEXT_CANDIDATE_VERSION,
      elidedMessages: stubs,
      fetchHint: "Elided comments are listed by id only; fetch one from the task comments API when you need its text.",
    },
    coverage: stubs.length ? { ...envelope.coverage, kind: "task_history_trimmed" } : envelope.coverage,
  };
}
