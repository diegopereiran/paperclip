# Native pull request watching for issue monitors

An issue monitor is a one-shot wake: the assignee agent sets `monitorNextCheckAt`
and `executionPolicy.monitor`, and Paperclip wakes the agent when the time is due.
Native pull request watching adds a second reason to wake: a GitHub pull request the
monitor names changed. The agent does not need a sleep loop, a shell watcher or
`gh pr checks` in a heartbeat.

The feature is on for every company, including companies created later. Nobody
opts in. An operator can turn it off at instance, company or agent level
([Turn it off](#turn-it-off)).

## What a monitor needs

A monitor is a candidate for pull request wakes when all of these hold:

- the issue has a scheduled monitor (`monitorNextCheckAt` is set);
- the assignee is an agent and no user is assigned;
- the status is `in_progress` or `in_review`;
- the company status is `active` (polling) and watching is not switched off (see below).

A wake consumes the monitor like a timed wake does: the monitor is stripped and the
agent must schedule a new one if it still waits. The wake carries the activity source
`pull_request_event`.

## How a monitor names a pull request

Paperclip reads three sources and merges them. Only github.com pull request URLs
and `owner/repo#number` references count.

1. **`executionPolicy.monitor.pullRequests`.** The server derives this list when the
   monitor is written, from the monitor's `externalRef`. The server stores the
   coordinates at write time because `externalRef` is redacted to `"[redacted]"`
   when the issue is read back.
2. **`monitorNotes`.** A pull request URL or `owner/repo#number` in the notes counts.
3. **`pull_request` work products.** A work product of type `pull_request` on the
   issue counts through its `url` or `externalId`.

The usual agent flow needs no extra step: open the PR, attach it as a
`pull_request` work product, and schedule the monitor.

## Two ways a wake happens

### Webhook (fast path)

When a company has a GitHub chat endpoint (a GitHub App installation), the existing
GitHub webhook receiver also routes pull request events to monitors. The event is
handled only after the HMAC signature and the installation check pass. A wake
happens at most once per delivery id: a receipt row of kind `github_monitor_event`
in `chat_actions` stops a redelivery from waking twice.

Events that wake a monitor:

| GitHub event | Action |
| --- | --- |
| `pull_request` | `opened`, `synchronize`, `closed` (reported as `merged` when merged), `ready_for_review`, `reopened` |
| `check_suite` | `completed` |
| `pull_request_review` | `submitted` |
| `pull_request_review_comment` | `created` |
| `issue_comment` | `created`, on a pull request only |

GitHub App settings:

- Subscribe the App to the five events above.
- Repository permissions: Pull requests (read), Checks (read), Metadata (read), in
  addition to the permissions the chat endpoint already needs.
- The webhook URL and secret are the ones of the chat endpoint. A new URL or secret
  is not needed.
- When an App gets new permissions or events, the installation owner must accept the
  change on GitHub, otherwise GitHub does not send the new events.

### Polling (fallback)

A company with only a GitHub token secret (no GitHub chat endpoint) is polled.
The poller runs in the server's timer tick.

- Each watched pull request is requested at most every 3 minutes.
- The token is a company secret named `GITHUB_TOKEN`, `GH_TOKEN` or
  `PAPERCLIP_GITHUB_TOKEN`, looked up in that order. A company without one is
  skipped.
- Requests use `ETag` and `If-None-Match`, so an unchanged pull request costs no
  rate limit.
- The poller keeps a fingerprint per pull request on the issue: head SHA, combined
  check conclusion (`none`, `pending`, `success`, `failure`), latest comment id,
  latest review id, state (`open`, `closed`, `merged`) and mergeable state.
- The first time the poller sees a pull request it stores the fingerprint as a
  baseline and does **not** wake. A later change in any field wakes the monitor once.
- A GitHub rate limit pauses polling for that company until the reset time (at most
  one hour). A 401 or 403 pauses it for 5 minutes. A pause in one company does not
  affect another.

A company with both a token and a chat endpoint gets webhook wakes and polling wakes.
They name the same change, and the consumed monitor makes the second one a no-op.

## Gate wake

An agent run that creates a gate issue (`originRunId`) is woken when the gate issue
reaches `done`, with wake reason `issue_origin_done`, even when the gate is neither
its child nor a blocker. A periodic backstop sweep wakes the origin when a code path
bypassed the status gate. This wake is a separate feature: it does not depend on a
pull request, and the watching switch does not change it.

## Turn it off

Resolution order, first match wins: instance, then company, then agent. A level that
is absent inherits.

| Level | How | Who |
| --- | --- | --- |
| Instance | `PATCH /api/instance/settings/general` with `{ "prMonitorWatching": false }` | Board |
| Company | `PATCH /api/companies/:companyId` with `{ "prMonitorWatching": false }`; `null` inherits | Board |
| Agent | set `runtimeConfig.prMonitorWatching` to `false` on the agent | Board |

Absent or `true` at the instance means on. A company can turn watching off when the
instance allows it. The instance value `false` turns it off for every company, and
no company or agent can turn it back on.

Turning it off stops both the webhook wake and the polling wake for the covered
monitors. Timed monitor wakes (`monitorNextCheckAt`) still work. A webhook that
arrives while watching is off is acknowledged and recorded as processed with no wake,
so a redelivery after you turn watching on again does not wake either. The next
change after that does.

No restart is needed: the setting is read on each poll and each webhook delivery.
