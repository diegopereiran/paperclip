# Instance disk reaper

A daily server job that frees disk and warns before it fills. It runs on the shared delivery scheduler (`instance-disk-reaper` queue): the next pass is due 24 h after the newest `disk-reaper-<YYYY-MM-DD>` report document, so a restart adds no pass, and never sooner than ten minutes after start. It waits while dispatch is drained. With `enabled: false` it schedules nothing; turning it back on takes effect at the next server start.
Code: `server/src/services/instance-disk-reaper.ts` (rules) and `instance-disk-reaper-runner.ts` (database and card wiring).

Removes, in order:

| Category | Rule |
| --- | --- |
| temp dirs | `paperclip-ai-*`, `paperclip-run-*`, `paperclip-ssh-*`, `paperclip-bridge-*` under the OS temp dir, untouched for `idleHours`, with no live run that could own them. A run scratch dir is matched to its run by its marker or the run id in its name; a provider home by its company id; ssh and bridge dirs by any live run older than the dir's last write. The dir of the current process is never removed. |
| isolated workspace attempts | `isolated-workspace-attempts/<company>/<issue>/<attempt>` (written by `materializeFreshWorkspaceSeed`, attempt id = run id) idle for `idleHours`, and owned by no live run and no execution workspace that is not archived. A workspace owns the attempt when its id is the attempt id (provider fresh workspace) or its `cwd` or `providerRef` is the attempt dir or inside it (a task workspace at `<attempt>/workspace`, which has its own id). |
| run logs | `*.ndjson` under the run-log base path older than `runLogRetentionDays`, except a live run's log. |
| database dumps | Beyond the newest `backupKeepCount` (this caps the backup runner's tiered keep). The newest dump and any dump whose name contains `-pre-` (for example `paperclip-pre-fork-<stamp>.dump`) are never removed; a pre-migration dump does not count toward the keep count. |

A live run is a heartbeat run in `queued`, `running` or `scheduled_retry`.

Limits are `general.diskReaper` instance settings: `enabled`, `dryRun`, `idleHours` (24), `runLogRetentionDays` (14), `backupKeepCount` (7), `diskAlertPercent` (85).
`dryRun` defaults to `true`: the first runs only log what they would delete, with bytes per category. Set `dryRun: false` to delete.
Every run logs the report: bytes freed per category (or reclaimable bytes in a dry run).
Every pass, dry run or real, also comments the report on the standing "Disk space alert" issue (the one the alert card uses): mode, and per category the count, bytes freed or reclaimable, and what was kept and why. The comment lists no paths, so the thread stays small. The full path list is the issue document `disk-reaper-<YYYY-MM-DD>`, replaced by a second pass on the same day. A failed comment or card is logged as a warning.

When data-disk use passes `diskAlertPercent`, the job posts one `request_confirmation` card (board user, `human_only`) with the top consumers on a standing "Disk space alert" issue (`originKind: instance_disk_alert`) in the oldest active company. No new card is posted while one is pending there.
