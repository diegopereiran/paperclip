import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, issues, issueWorkProducts } from "@paperclipai/db";
import { unprocessable } from "../errors.js";
import {
  extractGitHubPullRequestRefs,
  isValidGitHubName,
  mergeGitHubPullRequestRefs,
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

/**
 * Copies only the declared trigger fields so extra caller data never reaches a
 * wake payload. Throws when `repo` is not `owner/repo` or `number` is not a
 * positive safe integer: the trigger may come from a webhook body.
 */
export function sanitizeIssueMonitorTrigger(trigger: IssueMonitorTrigger): IssueMonitorTrigger {
  const repo = (boundedString(trigger.repo) ?? "").toLowerCase();
  const [owner, name, ...rest] = repo.split("/");
  if (!owner || !name || rest.length > 0 || !isValidGitHubName(owner) || !isValidGitHubName(name)) {
    throw unprocessable("Issue monitor trigger repo must be in owner/repo form");
  }
  if (typeof trigger.number !== "number" || !Number.isSafeInteger(trigger.number) || trigger.number <= 0) {
    throw unprocessable("Issue monitor trigger number must be a positive safe integer");
  }
  return {
    source: "github",
    event: boundedString(trigger.event) ?? "unknown",
    ...(boundedString(trigger.deliveryId) ? { deliveryId: boundedString(trigger.deliveryId) } : {}),
    repo,
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

interface MonitorCandidate {
  id: string;
  companyId: string;
  identifier: string | null;
  executionPolicy: unknown;
  monitorNotes: string | null;
  workProductRefs: GitHubPullRequestRef[];
}

/**
 * The scheduled monitors a pull request event can wake. The candidate gate
 * matches `triggerIssueMonitor`: a scheduled monitor, an agent assignee with
 * no user assignee, and an `in_progress` or `in_review` status. Without a
 * `companyId` the candidates of every active company are returned.
 */
async function loadMonitorCandidates(db: Db, scope: { companyId?: string }): Promise<MonitorCandidate[]> {
  const gate = [
    sql`${issues.monitorNextCheckAt} is not null`,
    isNull(issues.assigneeUserId),
    sql`${issues.assigneeAgentId} is not null`,
    inArray(issues.status, ["in_progress", "in_review"]),
  ];
  const rows = scope.companyId
    ? await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          identifier: issues.identifier,
          executionPolicy: issues.executionPolicy,
          monitorNotes: issues.monitorNotes,
        })
        .from(issues)
        .where(and(eq(issues.companyId, scope.companyId), ...gate))
    : await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          identifier: issues.identifier,
          executionPolicy: issues.executionPolicy,
          monitorNotes: issues.monitorNotes,
        })
        .from(issues)
        .innerJoin(companies, eq(companies.id, issues.companyId))
        .where(and(eq(companies.status, "active"), ...gate));
  if (rows.length === 0) return [];

  const workProducts = await db
    .select({
      issueId: issueWorkProducts.issueId,
      externalId: issueWorkProducts.externalId,
      url: issueWorkProducts.url,
    })
    .from(issueWorkProducts)
    .where(
      and(
        eq(issueWorkProducts.type, "pull_request"),
        inArray(
          issueWorkProducts.issueId,
          rows.map((row) => row.id),
        ),
      ),
    );
  const workProductRefs = new Map<string, GitHubPullRequestRef[]>();
  for (const product of workProducts) {
    const refs = extractGitHubPullRequestRefs(product.url, product.externalId);
    workProductRefs.set(product.issueId, mergeGitHubPullRequestRefs(workProductRefs.get(product.issueId) ?? [], refs));
  }
  return rows.map((row) => ({ ...row, workProductRefs: workProductRefs.get(row.id) ?? [] }));
}

function monitorPullRequestRefs(candidate: MonitorCandidate) {
  const policy = candidate.executionPolicy as { monitor?: { pullRequests?: unknown } | null } | null;
  return {
    pullRequests: parseGitHubPullRequestRefs(policy?.monitor?.pullRequests),
    notes: extractGitHubPullRequestRefs(candidate.monitorNotes),
    workProduct: candidate.workProductRefs,
  };
}

/**
 * Finds the company's issues that have a scheduled monitor naming a pull
 * request. A monitor names a pull request through the server-derived
 * `monitor.pullRequests`, its `monitorNotes`, or a `pull_request` work
 * product on the issue.
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

  const matches: IssueMonitorPullRequestMatch[] = [];
  for (const candidate of await loadMonitorCandidates(db, { companyId: input.companyId })) {
    const refs = monitorPullRequestRefs(candidate);
    const matchedBy: IssueMonitorPullRequestMatchSource[] = [];
    if (includesRef(refs.pullRequests, target)) matchedBy.push("pullRequests");
    if (includesRef(refs.notes, target)) matchedBy.push("notes");
    if (includesRef(refs.workProduct, target)) matchedBy.push("workProduct");
    if (matchedBy.length > 0) {
      matches.push({ issueId: candidate.id, identifier: candidate.identifier ?? null, matchedBy });
    }
  }
  return matches;
}

export interface WatchedMonitorPullRequests {
  issueId: string;
  companyId: string;
  identifier: string | null;
  pullRequests: GitHubPullRequestRef[];
  hasMonitorPolicy: boolean;
  /** `executionPolicy.monitor.pullRequestState`, unvalidated. */
  pullRequestState: unknown;
}

/**
 * Every scheduled monitor of every active company with the pull requests it
 * names, for the polling fallback. Same candidate gate and reference sources
 * as `findIssuesWithMonitorForPullRequest`.
 */
export async function listWatchedMonitorPullRequests(db: Db): Promise<WatchedMonitorPullRequests[]> {
  const watched: WatchedMonitorPullRequests[] = [];
  for (const candidate of await loadMonitorCandidates(db, {})) {
    const refs = monitorPullRequestRefs(candidate);
    const pullRequests = mergeGitHubPullRequestRefs(refs.pullRequests, refs.notes, refs.workProduct);
    if (pullRequests.length === 0) continue;
    const monitor = (candidate.executionPolicy as { monitor?: { pullRequestState?: unknown } | null } | null)?.monitor;
    watched.push({
      issueId: candidate.id,
      companyId: candidate.companyId,
      identifier: candidate.identifier,
      pullRequests,
      hasMonitorPolicy: Boolean(monitor),
      pullRequestState: monitor?.pullRequestState,
    });
  }
  return watched;
}
