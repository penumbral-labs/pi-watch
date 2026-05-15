# pi-watch

Focused Pi temporal tools for waiting across long spans.

This package intentionally does only temporal waiting. It is not a goals runner, scheduler, metrics collector, or notification bundle.

## Install

```bash
pi install ../../src/github.com/penumbral-labs/pi-watch
```

## Tools

### Wait/Watch tools

- `wait_for_pid({ pid, pollMs?, timeoutMs?, background?, group?, label?, supersedeGroup? })` — wait until a local PID exits.
- `wait_for_command({ command, cwd?, intervalMs?, timeoutMs?, background?, group?, label?, supersedeGroup? })` — poll a command until it exits 0.
- `watch_file({ path, pollMs?, timeoutMs?, minSize?, modifiedAfterMs?, contentIncludes?, fromNow?, background?, group?, label?, supersedeGroup? })` — wait for file conditions.
- `sleep_until({ isoTime, timeoutMs?, background?, group?, label?, supersedeGroup? })` — wait until a deadline.

### Management tools

- `list_watches({ group? })` — list all active and recent background watches with group, status, and elapsed time.
- `cancel_watch({ id })` — cancel a specific watch by its `watchId`.
- `cancel_group({ group })` — cancel all active watches in a group.

## Grouping & superseding

All wait/watch tools accept optional `group`, `label`, and `supersedeGroup` parameters for managing related watchers:

```json
{
  "path": "/tmp/rerun-4096.log",
  "contentIncludes": "milestone reached",
  "group": "heartwood-rerun-4096",
  "label": "embed milestone",
  "supersedeGroup": true
}
```

- **`group`** — logical grouping key (e.g. `"heartwood-rerun-4096"`). Used for bulk cancellation and status filtering.
- **`label`** — human-readable label for this specific watch (appears in notifications and status listings).
- **`supersedeGroup`** — when `true`, cancels all existing active watches in the same group before starting this one. Prevents stale notifications from watchers started for previous runs.

## `fromNow` file watching

`watch_file` accepts `fromNow: true` to only match content appended/modified after watch start. This prevents immediate firing on pre-existing matching content — useful for log tailing where you only care about new entries.

```json
{
  "path": "/tmp/output.log",
  "contentIncludes": "BUILD SUCCESS",
  "fromNow": true
}
```

## Watch IDs

Watches receive type-prefixed globally monotonic IDs:

- `pid-17` — wait_for_pid
- `cmd-19` — wait_for_command
- `file-18` — watch_file
- `sleep-20` — sleep_until

IDs are unique across all types and never reused within a session.

## Notification context

Wake-up notifications include rich context to distinguish active vs. stale watches:

- **Active completion:** `[run-5] watch_file: embed check (/tmp/out.log) completed after 1234ms`
- **Stale/superseded:** `[run-2] watch_file (stale/superseded by file-42): old watcher — cancelled`
- **Manually cancelled:** `[batch] wait_for_pid (manually cancelled): pid watcher — cancelled`
- **Timed out:** `[run-3] watch_file: slow file (/tmp/slow.log) timed out after 10000ms`

## Status bar

When watches are active, a status line appears in the Pi footer:

```
🔍 3 watches: [heartwood-rerun-4096] pid-17(12s) file-18(3s) cmd-19(8s)
```

This updates in real time as watches start, complete, or are cancelled.

## Background behavior

All tools start in background mode by default. A background wait returns immediately with a `watchId`, then injects a
`[pi-watch]` custom follow-up/wake message when the condition completes, times out, fails, or is cancelled. This avoids
long-running tool calls hitting Pi/RPC timeouts such as `timed out after 300001ms`.

Pass `background: false` when the next step truly needs the blocking result in the same tool call. Foreground waits still
stream progress updates and honor cancellation/timeout.

Background waits are in-memory extension work. They survive while the current Pi process/session is running; they are
cancelled on session shutdown and are not a persistent scheduler.
