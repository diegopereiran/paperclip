import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatActions } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { isValidGitHubName } from "./github-pull-request-refs.js";
import {
  findIssuesWithMonitorForPullRequest,
  type IssueMonitorTrigger,
} from "./issue-monitor-pull-requests.js";

/** Events that only feed the monitor sink. The chat adapter never sees them. */
export const GITHUB_MONITOR_ONLY_EVENTS: ReadonlySet<string> = new Set([
  "pull_request",
  "check_suite",
  "pull_request_review",
]);

/** Chat events that additionally feed the monitor sink when they concern a pull request. */
const GITHUB_MONITOR_COMMENT_EVENTS: ReadonlySet<string> = new Set([
  "issue_comment",
  "pull_request_review_comment",
]);

const PULL_REQUEST_ACTIONS = new Set(["opened", "synchronize", "closed", "ready_for_review", "reopened"]);
const RECEIPT_KIND = "github_monitor_event";

export function isGitHubMonitorEvent(eventType: string) {
  return GITHUB_MONITOR_ONLY_EVENTS.has(eventType) || GITHUB_MONITOR_COMMENT_EVENTS.has(eventType);
}

export interface GitHubMonitorWebhookTarget {
  event: string;
  repo: string;
  number: number;
  headSha: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function repositoryFullName(payload: Record<string, unknown>) {
  const fullName = asRecord(payload.repository)?.full_name;
  if (typeof fullName !== "string") return null;
  const [owner, name, ...rest] = fullName.split("/");
  if (!owner || !name || rest.length > 0 || !isValidGitHubName(owner) || !isValidGitHubName(name)) return null;
  return fullName.toLowerCase();
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function shaOf(value: unknown) {
  const sha = asRecord(asRecord(value)?.head)?.sha;
  return typeof sha === "string" && sha.length > 0 ? sha : null;
}

/**
 * Reads the pull requests an authenticated GitHub webhook event concerns.
 * Returns an empty list for any event or action the monitors do not wake on.
 * Reads coordinates and the head sha only, never comment or review text.
 */
export function extractGitHubMonitorTargets(eventType: string, rawPayload: unknown): GitHubMonitorWebhookTarget[] {
  const payload = asRecord(rawPayload);
  if (!payload) return [];
  const repo = repositoryFullName(payload);
  if (!repo) return [];
  const action = typeof payload.action === "string" ? payload.action : null;
  const target = (event: string, number: unknown, headSha: string | null) => {
    const valid = positiveInteger(number);
    return valid === null ? [] : [{ event, repo, number: valid, headSha }];
  };

  switch (eventType) {
    case "pull_request": {
      if (!action || !PULL_REQUEST_ACTIONS.has(action)) return [];
      const pullRequest = asRecord(payload.pull_request);
      const merged = action === "closed" && pullRequest?.merged === true;
      return target(`pull_request:${merged ? "merged" : action}`, pullRequest?.number, shaOf(pullRequest));
    }
    case "check_suite": {
      if (action !== "completed") return [];
      const suite = asRecord(payload.check_suite);
      const repositoryId = asRecord(payload.repository)?.id;
      const entries = Array.isArray(suite?.pull_requests) ? suite.pull_requests : [];
      const targets: GitHubMonitorWebhookTarget[] = [];
      for (const entry of entries) {
        const baseRepositoryId = asRecord(asRecord(asRecord(entry)?.base)?.repo)?.id;
        // The repo comes from the signed envelope: skip entries of another repository.
        if (baseRepositoryId !== undefined && baseRepositoryId !== repositoryId) continue;
        const headSha = shaOf(entry) ?? (typeof suite?.head_sha === "string" ? suite.head_sha : null);
        targets.push(...target("check_suite:completed", asRecord(entry)?.number, headSha));
      }
      return targets;
    }
    case "pull_request_review":
      if (action !== "submitted") return [];
      return target("pull_request_review:submitted", asRecord(payload.pull_request)?.number, shaOf(payload.pull_request));
    case "pull_request_review_comment":
      if (action !== "created") return [];
      return target("pull_request_review_comment:created", asRecord(payload.pull_request)?.number, shaOf(payload.pull_request));
    case "issue_comment": {
      if (action !== "created") return [];
      const issue = asRecord(payload.issue);
      if (!asRecord(issue?.pull_request)) return [];
      return target("issue_comment:created", issue?.number, null);
    }
    default:
      return [];
  }
}

export interface GitHubMonitorWebhookInput {
  companyId: string;
  endpointId: string;
  eventType: string;
  deliveryId: string;
  /** The parsed body of a webhook whose signature and installation are already verified. */
  payload: unknown;
}

export type GitHubMonitorWebhookResult =
  | { outcome: "ignored"; woken: 0 }
  | { outcome: "duplicate"; woken: 0 }
  | { outcome: "processed"; woken: number };

export interface GitHubMonitorWebhookSinkOptions {
  triggerMonitor: (
    issueId: string,
    input: { actorType: "system"; actorId: string; trigger: IssueMonitorTrigger },
  ) => Promise<unknown>;
  log?: Pick<typeof logger, "debug" | "warn">;
}

/**
 * Wakes the scheduled issue monitors that name the pull request an
 * authenticated GitHub webhook event concerns. Callers must verify the
 * signature and installation first. The sink never enters the chat adapter.
 * A redelivery of the same delivery id is a no-op once processed.
 */
export function createGitHubMonitorWebhookSink(db: Db, options: GitHubMonitorWebhookSinkOptions) {
  const log = options.log ?? logger;

  async function handle(input: GitHubMonitorWebhookInput): Promise<GitHubMonitorWebhookResult> {
    const targets = extractGitHubMonitorTargets(input.eventType, input.payload);
    if (targets.length === 0) return { outcome: "ignored", woken: 0 };

    const providerActionId = `${RECEIPT_KIND}:${input.deliveryId}`;
    const [inserted] = await db
      .insert(chatActions)
      .values({
        companyId: input.companyId,
        endpointId: input.endpointId,
        kind: RECEIPT_KIND,
        providerActionId,
        payload: { eventType: input.eventType, targets: targets.map((t) => `${t.repo}#${t.number}`) },
        status: "received",
      })
      .onConflictDoNothing()
      .returning({ id: chatActions.id });
    const receiptId =
      inserted?.id ??
      (await db
        .select({ id: chatActions.id, status: chatActions.status })
        .from(chatActions)
        .where(and(eq(chatActions.endpointId, input.endpointId), eq(chatActions.providerActionId, providerActionId)))
        .then((rows) => (rows[0]?.status === "processed" ? null : (rows[0]?.id ?? null))));
    if (!receiptId) return { outcome: "duplicate", woken: 0 };

    let woken = 0;
    let transientFailure: unknown = null;
    for (const target of targets) {
      const [owner, repo] = target.repo.split("/") as [string, string];
      const matches = await findIssuesWithMonitorForPullRequest(db, {
        companyId: input.companyId,
        owner,
        repo,
        number: target.number,
      });
      for (const match of matches) {
        try {
          await options.triggerMonitor(match.issueId, {
            actorType: "system",
            actorId: "github_pull_request_webhook",
            trigger: {
              source: "github",
              event: target.event,
              deliveryId: input.deliveryId,
              repo: target.repo,
              number: target.number,
              headSha: target.headSha,
            },
          });
          woken += 1;
        } catch (err) {
          // 404/409: the monitor was cleared or claimed since the lookup, which is the normal race.
          if (err instanceof HttpError && (err.status === 404 || err.status === 409)) {
            log.debug({ err, issueId: match.issueId }, "pull request webhook did not wake a monitor");
          } else {
            log.warn({ err, issueId: match.issueId }, "pull request webhook could not wake a monitor");
            transientFailure ??= err;
          }
        }
      }
    }
    // Leave the receipt unprocessed so a redelivery of the same delivery retries.
    if (transientFailure) throw transientFailure;

    await db
      .update(chatActions)
      .set({ status: "processed", result: { woken }, updatedAt: new Date() })
      .where(eq(chatActions.id, receiptId));
    return { outcome: "processed", woken };
  }

  return { handle };
}

export type GitHubMonitorWebhookSink = ReturnType<typeof createGitHubMonitorWebhookSink>;
