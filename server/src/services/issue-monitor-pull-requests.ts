import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, issueWorkProducts } from "@paperclipai/db";
import {
  extractGitHubPullRequestRefs,
  parseGitHubPullRequestRefs,
  type GitHubPullRequestRef,
} from "./github-pull-request-refs.js";

export interface IssueMonitorTrigger {
  source: "github";
  event: string;
  deliveryId?: string | null;
  /** `owner/repo`, lower-cased. */
  repo: string;
  number: number;
  headSha?: string | null;
}

export type IssueMonitorPullRequestMatchSource = "pullRequests" | "notes" | "workProduct";

export interface IssueMonitorPullRequestMatch {
  issueId: string;
  identifier: string | null;
  matchedBy: IssueMonitorPullRequestMatchSource[];
}

const MAX_TRIGGER_FIELD_LENGTH = 200;

function boundedString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, MAX_TRIGGER_FIELD_LENGTH) : null;
}

/** Copies only the declared trigger fields so extra caller data never reaches a wake payload. */
export function sanitizeIssueMonitorTrigger(trigger: IssueMonitorTrigger): IssueMonitorTrigger {
  return {
    source: "github",
    event: boundedString(trigger.event) ?? "unknown",
    ...(boundedString(trigger.deliveryId) ? { deliveryId: boundedString(trigger.deliveryId) } : {}),
    repo: (boundedString(trigger.repo) ?? "").toLowerCase(),
    number: trigger.number,
    ...(boundedString(trigger.headSha) ? { headSha: boundedString(trigger.headSha) } : {}),
  };
}

function sameRef(left: GitHubPullRequestRef, right: GitHubPullRequestRef) {
  return left.owner === right.owner && left.repo === right.repo && left.number === right.number;
}

function includesRef(refs: GitHubPullRequestRef[], target: GitHubPullRequestRef) {
  return refs.some((ref) => sameRef(ref, target));
}

/**
 * Finds the company's issues that have a scheduled monitor naming a pull
 * request. The candidate gate matches `triggerIssueMonitor`: a scheduled
 * monitor, an agent assignee with no user assignee, and an `in_progress` or
 * `in_review` status. A monitor names a pull request through the
 * server-derived `monitor.pullRequests`, its `monitorNotes`, or a
 * `pull_request` work product on the issue.
 */
export async function findIssuesWithMonitorForPullRequest(
  db: Db,
  input: { companyId: string; owner: string; repo: string; number: number },
): Promise<IssueMonitorPullRequestMatch[]> {
  const target: GitHubPullRequestRef = {
    owner: input.owner.toLowerCase(),
    repo: input.repo.toLowerCase(),
    number: input.number,
  };

  const candidates = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      executionPolicy: issues.executionPolicy,
      monitorNotes: issues.monitorNotes,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        sql`${issues.monitorNextCheckAt} is not null`,
        isNull(issues.assigneeUserId),
        sql`${issues.assigneeAgentId} is not null`,
        inArray(issues.status, ["in_progress", "in_review"]),
      ),
    );
  if (candidates.length === 0) return [];

  const workProducts = await db
    .select({
      issueId: issueWorkProducts.issueId,
      externalId: issueWorkProducts.externalId,
      url: issueWorkProducts.url,
    })
    .from(issueWorkProducts)
    .where(
      and(
        eq(issueWorkProducts.companyId, input.companyId),
        eq(issueWorkProducts.type, "pull_request"),
        inArray(
          issueWorkProducts.issueId,
          candidates.map((candidate) => candidate.id),
        ),
      ),
    );
  const workProductIssueIds = new Set(
    workProducts
      .filter((product) =>
        includesRef(extractGitHubPullRequestRefs(product.url, product.externalId), target),
      )
      .map((product) => product.issueId),
  );

  const matches: IssueMonitorPullRequestMatch[] = [];
  for (const candidate of candidates) {
    const policy = candidate.executionPolicy as { monitor?: { pullRequests?: unknown } | null } | null;
    const matchedBy: IssueMonitorPullRequestMatchSource[] = [];
    if (includesRef(parseGitHubPullRequestRefs(policy?.monitor?.pullRequests), target)) {
      matchedBy.push("pullRequests");
    }
    if (includesRef(extractGitHubPullRequestRefs(candidate.monitorNotes), target)) {
      matchedBy.push("notes");
    }
    if (workProductIssueIds.has(candidate.id)) matchedBy.push("workProduct");
    if (matchedBy.length > 0) {
      matches.push({ issueId: candidate.id, identifier: candidate.identifier ?? null, matchedBy });
    }
  }
  return matches;
}
