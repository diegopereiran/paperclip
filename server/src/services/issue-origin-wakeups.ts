export const ISSUE_ORIGIN_DONE_WAKE_REASON = "issue_origin_done";

export type WakeableOriginIssue = {
  id: string;
  assigneeAgentId: string;
  doneIssueId: string;
};

export function buildIssueOriginDoneWakeIdempotencyKey(input: {
  originIssueId: string;
  doneIssueId: string;
}) {
  return `${ISSUE_ORIGIN_DONE_WAKE_REASON}:${input.originIssueId}:${input.doneIssueId}`;
}

export function buildIssueOriginDoneWakePayload(origin: WakeableOriginIssue) {
  return {
    issueId: origin.id,
    doneIssueId: origin.doneIssueId,
  };
}

export function buildIssueOriginDoneWakeContext(origin: WakeableOriginIssue) {
  return {
    issueId: origin.id,
    taskId: origin.id,
    wakeReason: ISSUE_ORIGIN_DONE_WAKE_REASON,
    source: "issue.origin_done",
    doneIssueId: origin.doneIssueId,
  };
}
