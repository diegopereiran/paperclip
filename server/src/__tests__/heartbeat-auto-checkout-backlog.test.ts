import { describe, expect, it } from "vitest";
import { shouldAutoCheckoutIssueForWake } from "../services/heartbeat.ts";

function backlogInput(wakeReason: string) {
  return {
    contextSnapshot: { wakeReason } as Record<string, unknown>,
    issueStatus: "backlog",
    issueAssigneeAgentId: "agent-1",
    isDependencyReady: true,
    agentId: "agent-1",
  };
}

describe("shouldAutoCheckoutIssueForWake on a parked backlog issue", () => {
  it.each([
    "issue_continuation_needed",
    "issue_commented",
    "issue_status_changed",
    "issue_monitor_due",
    "issue_recovery_action_restored",
    "transient_failure_retry",
  ])("keeps a backlog issue parked on a %s wake", (wakeReason) => {
    expect(shouldAutoCheckoutIssueForWake(backlogInput(wakeReason))).toBe(false);
  });

  it("still checks out a backlog issue explicitly assigned to the agent", () => {
    expect(shouldAutoCheckoutIssueForWake(backlogInput("issue_assigned"))).toBe(true);
  });

  it("still checks out a todo issue on a continuation wake", () => {
    expect(
      shouldAutoCheckoutIssueForWake({ ...backlogInput("issue_continuation_needed"), issueStatus: "todo" }),
    ).toBe(true);
  });
});
