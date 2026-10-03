import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { defaultTokenProvider, retryAfterSeconds } from "./github-external-object-provider.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import { DEFAULT_GITHUB_TOKEN_SECRET_NAMES } from "./git-credentials.js";
import {
  actionableFingerprintChange,
  changedFingerprintFields,
  parsePullRequestState,
  pullRequestStateKey,
  summarizeCheckSuites,
  type PullRequestFingerprint,
} from "./github-pull-request-fingerprint.js";
import type { GitHubPullRequestRef } from "./github-pull-request-refs.js";
import {
  listWatchedMonitorPullRequests,
  type IssueMonitorTrigger,
  type WatchedMonitorPullRequests,
} from "./issue-monitor-pull-requests.js";

/** Each watched pull request is requested at most this often (plan: every 2 to 5 minutes). */
export const PULL_REQUEST_POLL_INTERVAL_MS = 3 * 60 * 1000;
const MAX_PAUSE_SECONDS = 60 * 60;
const AUTH_PAUSE_SECONDS = 5 * 60;
const REQUEST_TIMEOUT_MS = 20_000;
const GITHUB_API_ORIGIN = gitHubApiBase("github.com");

type PollerLog = Pick<typeof logger, "info" | "warn" | "debug" | "error">;

export interface PullRequestMonitorPollerOptions {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Resolves the company's own GitHub token; `null` means the company has none. */
  getToken?: (companyId: string) => Promise<string | null>;
  triggerMonitor: (
    issueId: string,
    input: {
      now: Date;
      actorType: "system";
      actorId: string;
      trigger: IssueMonitorTrigger;
    },
  ) => Promise<unknown>;
  intervalMs?: number;
  log?: PollerLog;
}

export interface PullRequestPollResult {
  /** Pull requests requested from GitHub during this tick. */
  polled: number;
  baselined: number;
  woken: number;
}

interface CachedResponse<T> {
  etag: string | null;
  value: T;
}

interface PullRequestCacheEntry {
  polledAt: number;
  sinceIso: string;
  responses: Map<string, CachedResponse<unknown>>;
  fingerprint: PullRequestFingerprint | null;
}

type GetResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "paused"; seconds: number; reason: "rate_limited" | "auth" }
  | { kind: "failed" };

function maxId(value: unknown) {
  if (!Array.isArray(value)) return null;
  let max: number | null = null;
  for (const entry of value) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id === "number" && Number.isSafeInteger(id) && (max === null || id > max)) max = id;
  }
  return max;
}

function latestComment(value: unknown): { id: number | null; author: string | null } {
  const id = maxId(value);
  if (id === null || !Array.isArray(value)) return { id: null, author: null };
  const entry = value.find((candidate) => (candidate as { id?: unknown } | null)?.id === id) as
    | { user?: { login?: unknown } | null }
    | undefined;
  const login = entry?.user?.login;
  return { id, author: typeof login === "string" && login.length > 0 && login.length <= 100 ? login : null };
}

function isRateLimited(response: Response) {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  return response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after");
}

export function createPullRequestMonitorPoller(db: Db, options: PullRequestMonitorPollerOptions) {
  const fetchImpl = options.fetch ?? ghFetch;
  const getToken = options.getToken ?? ((companyId: string) => defaultTokenProvider(db, companyId, DEFAULT_GITHUB_TOKEN_SECRET_NAMES));
  const intervalMs = options.intervalMs ?? PULL_REQUEST_POLL_INTERVAL_MS;
  const log = options.log ?? logger;

  const cache = new Map<string, PullRequestCacheEntry>();
  const pausedUntil = new Map<string, number>();
  const noTokenLogged = new Set<string>();
  const wakeRetryAt = new Map<string, number>();
  const ownLogins = new Map<string, string>();
  let running = false;

  async function request<T>(
    token: string,
    entry: PullRequestCacheEntry,
    url: string,
    map: (body: unknown) => T,
  ): Promise<GetResult<T>> {
    const cached = entry.responses.get(url) as CachedResponse<T> | undefined;
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "paperclip-pull-request-monitor",
      "x-github-api-version": "2022-11-28",
      authorization: `Bearer ${token}`,
    };
    if (cached?.etag) headers["if-none-match"] = cached.etag;

    let response: Response;
    try {
      response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      return { kind: "failed" };
    }
    if (response.status === 304 && cached) return { kind: "ok", value: cached.value };
    if (isRateLimited(response)) {
      return { kind: "paused", seconds: Math.min(retryAfterSeconds(response), MAX_PAUSE_SECONDS), reason: "rate_limited" };
    }
    if (response.status === 401) {
      return { kind: "paused", seconds: AUTH_PAUSE_SECONDS, reason: "auth" };
    }
    if (response.status !== 200) return { kind: "failed" };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: "failed" };
    }
    const value = map(body);
    entry.responses.set(url, { etag: response.headers.get("etag"), value });
    return { kind: "ok", value };
  }

  async function fetchFingerprint(
    token: string,
    ref: GitHubPullRequestRef,
    entry: PullRequestCacheEntry,
  ): Promise<GetResult<PullRequestFingerprint>> {
    const base = `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
    const pull = await request(token, entry, `${base}/pulls/${ref.number}`, (body) => {
      const data = body as {
        state?: unknown;
        merged?: unknown;
        merged_at?: unknown;
        mergeable_state?: unknown;
        head?: { sha?: unknown } | null;
      };
      const merged = data.merged === true || typeof data.merged_at === "string";
      return {
        state: (merged ? "merged" : data.state === "closed" ? "closed" : "open") as PullRequestFingerprint["state"],
        headSha: typeof data.head?.sha === "string" ? data.head.sha : null,
        mergeableState:
          typeof data.mergeable_state === "string" && data.mergeable_state !== "unknown" ? data.mergeable_state : null,
      };
    });
    if (pull.kind !== "ok") return pull;

    const suites = pull.value.headSha
      ? await request(
          token,
          entry,
          `${base}/commits/${encodeURIComponent(pull.value.headSha)}/check-suites?per_page=100`,
          (body) => {
            const list = (body as { check_suites?: unknown } | null)?.check_suites;
            return summarizeCheckSuites(Array.isArray(list) ? list : []);
          },
        )
      : ({ kind: "ok", value: "none" } as const);
    if (suites.kind !== "ok") return suites;

    const comments = await request(
      token,
      entry,
      `${base}/issues/${ref.number}/comments?since=${encodeURIComponent(entry.sinceIso)}&per_page=100`,
      latestComment,
    );
    if (comments.kind !== "ok") return comments;

    const reviews = await request(token, entry, `${base}/pulls/${ref.number}/reviews?per_page=100`, maxId);
    if (reviews.kind !== "ok") return reviews;

    return {
      kind: "ok",
      value: {
        headSha: pull.value.headSha,
        checkConclusion: suites.value,
        latestCommentId: comments.value.id,
        latestCommentAuthor: comments.value.author,
        latestReviewId: reviews.value,
        state: pull.value.state,
        mergeableState: pull.value.mergeableState ?? entry.fingerprint?.mergeableState ?? null,
      },
    };
  }

  /** The token owner's login, resolved once per token; `null` (not cached) when `GET /user` fails. */
  async function resolveOwnLogin(token: string, companyId: string): Promise<string | null> {
    const cached = ownLogins.get(token);
    if (cached) return cached;
    try {
      const response = await fetchImpl(`${GITHUB_API_ORIGIN}/user`, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "paperclip-pull-request-monitor",
          "x-github-api-version": "2022-11-28",
          authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200) {
        const login = ((await response.json()) as { login?: unknown } | null)?.login;
        if (typeof login === "string" && login.length > 0) {
          ownLogins.set(token, login);
          return login;
        }
      }
    } catch {
      // fall through to fail open
    }
    log.warn({ companyId }, "pull request monitor could not resolve the token's GitHub login; every new comment wakes");
    return null;
  }

  async function writeBaseline(issueId: string, key: string, fingerprint: PullRequestFingerprint) {
    await db
      .update(issues)
      .set({
        executionPolicy: sql`jsonb_set(
          ${issues.executionPolicy},
          '{monitor,pullRequestState}',
          coalesce(${issues.executionPolicy} #> '{monitor,pullRequestState}', '{}'::jsonb)
            || jsonb_build_object(${key}::text, ${JSON.stringify(fingerprint)}::jsonb),
          true
        )`,
      })
      .where(
        and(
          eq(issues.id, issueId),
          sql`${issues.executionPolicy} #> '{monitor}' is not null`,
          sql`${issues.monitorNextCheckAt} is not null`,
        ),
      );
  }

  async function resolveToken(companyId: string): Promise<string | null> {
    try {
      const token = (await getToken(companyId))?.trim();
      return token || null;
    } catch {
      return null;
    }
  }

  async function poll(now: Date = new Date()): Promise<PullRequestPollResult> {
    if (running) return { polled: 0, baselined: 0, woken: 0 };
    running = true;
    try {
      return await pollOnce(now);
    } finally {
      running = false;
    }
  }

  async function pollOnce(now: Date): Promise<PullRequestPollResult> {
    const result: PullRequestPollResult = { polled: 0, baselined: 0, woken: 0 };
    const nowMs = now.getTime();
    for (const [retryKey, retryAt] of wakeRetryAt) if (retryAt <= nowMs) wakeRetryAt.delete(retryKey);
    const watched = (await listWatchedMonitorPullRequests(db)).filter((entry) => entry.hasMonitorPolicy);

    const byCompany = new Map<string, Map<string, { ref: GitHubPullRequestRef; monitors: WatchedMonitorPullRequests[] }>>();
    for (const monitor of watched) {
      let refs = byCompany.get(monitor.companyId);
      if (!refs) byCompany.set(monitor.companyId, (refs = new Map()));
      for (const ref of monitor.pullRequests) {
        const key = pullRequestStateKey(ref);
        const group = refs.get(key);
        if (group) group.monitors.push(monitor);
        else refs.set(key, { ref, monitors: [monitor] });
      }
    }

    const watchedCacheKeys = new Set<string>();
    for (const [companyId, refs] of byCompany) {
      for (const key of refs.keys()) watchedCacheKeys.add(`${companyId}|${key}`);
    }
    for (const cacheKey of cache.keys()) if (!watchedCacheKeys.has(cacheKey)) cache.delete(cacheKey);

    for (const [companyId, refs] of byCompany) {
      if ((pausedUntil.get(companyId) ?? 0) > nowMs) continue;
      let token: string | null | undefined;

      for (const [key, { ref, monitors }] of refs) {
        const cacheKey = `${companyId}|${key}`;
        let entry = cache.get(cacheKey);
        const fresh = entry !== undefined && nowMs - entry.polledAt < intervalMs;

        if (!fresh) {
          if (token === undefined) {
            token = await resolveToken(companyId);
            if (!token) {
              pausedUntil.set(companyId, nowMs + intervalMs);
              if (!noTokenLogged.has(companyId)) {
                noTokenLogged.add(companyId);
                log.info({ companyId }, "pull request monitor polling skipped: company has no GitHub token");
              }
            } else {
              noTokenLogged.delete(companyId);
            }
          }
          if (!token) break;

          entry ??= { polledAt: 0, sinceIso: now.toISOString(), responses: new Map(), fingerprint: null };
          entry.polledAt = nowMs;
          cache.set(cacheKey, entry);
          const fetched = await fetchFingerprint(token, ref, entry);
          result.polled += 1;
          if (fetched.kind === "paused") {
            const seconds = fetched.seconds;
            pausedUntil.set(companyId, nowMs + seconds * 1000);
            log.warn(
              { companyId, reason: fetched.reason, pauseSeconds: seconds },
              "pull request monitor polling paused for company",
            );
            break;
          }
          if (fetched.kind === "failed") {
            log.debug({ companyId, pullRequest: key }, "pull request monitor poll failed; will retry later");
            continue;
          }
          entry.fingerprint = fetched.value;
        }

        const current = entry?.fingerprint;
        if (!current) continue;

        for (const monitor of monitors) {
          const stored = parsePullRequestState(monitor.pullRequestState)[key];
          if (!stored) {
            await writeBaseline(monitor.issueId, key, current);
            result.baselined += 1;
            continue;
          }
          const changedFields = changedFingerprintFields(stored, current);
          if (changedFields.length === 0) {
            if (stored.mergeableState === null && current.mergeableState !== null) {
              await writeBaseline(monitor.issueId, key, { ...stored, mergeableState: current.mergeableState });
            }
            continue;
          }
          let ownLogin: string | null = null;
          if (changedFields.includes("comment")) {
            const commentToken = token ?? (await resolveToken(companyId));
            ownLogin = commentToken ? await resolveOwnLogin(commentToken, companyId) : null;
          }
          const changed = actionableFingerprintChange(stored, current, { ownLogin });
          if (changed.length === 0) {
            // Nothing worth a wake: advance the baseline so the same data does not come up again.
            await writeBaseline(monitor.issueId, key, {
              ...current,
              latestCommentId: current.latestCommentId ?? stored.latestCommentId,
              latestCommentAuthor:
                current.latestCommentId === null ? stored.latestCommentAuthor ?? null : current.latestCommentAuthor,
              latestReviewId: current.latestReviewId ?? stored.latestReviewId,
              mergeableState: current.mergeableState ?? stored.mergeableState,
            });
            continue;
          }
          const retryKey = `${monitor.issueId}|${key}`;
          if (wakeRetryAt.has(retryKey)) continue;
          try {
            await options.triggerMonitor(monitor.issueId, {
              now,
              actorType: "system",
              actorId: "github_pull_request_poll",
              trigger: {
                source: "github",
                event: `poll:${changed.join("+")}`,
                repo: `${ref.owner}/${ref.repo}`,
                number: ref.number,
                headSha: current.headSha,
              },
            });
            result.woken += 1;
          } catch (err) {
            wakeRetryAt.set(retryKey, nowMs + intervalMs);
            log.debug({ err, issueId: monitor.issueId }, "pull request monitor wake was not dispatched");
          }
        }
      }
    }
    return result;
  }

  return { poll };
}
