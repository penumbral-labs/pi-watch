# pi-watch

Focused Pi temporal tools for waiting across long spans.

This package intentionally does only temporal waiting. It is not a goals runner, scheduler, metrics collector, or notification bundle.

## Install

```bash
pi install ../../src/github.com/penumbral-labs/pi-watch
```

## Tools

- `wait_for_pid({ pid, pollMs?, timeoutMs?, background? })` — wait until a local PID exits.
- `wait_for_command({ command, cwd?, intervalMs?, timeoutMs?, background? })` — poll a command until it exits 0.
- `watch_file({ path, pollMs?, timeoutMs?, minSize?, modifiedAfterMs?, contentIncludes?, background? })` — wait for file conditions.
- `sleep_until({ isoTime, timeoutMs?, background? })` — wait until a deadline.

## Background behavior

All tools start in background mode by default. A background wait returns immediately with a `watchId`, then injects a
`[pi-watch]` custom follow-up/wake message when the condition completes, times out, fails, or is cancelled. This avoids
long-running tool calls hitting Pi/RPC timeouts such as `timed out after 300001ms`.

Pass `background: false` when the next step truly needs the blocking result in the same tool call. Foreground waits still
stream progress updates and honor cancellation/timeout.

Background waits are in-memory extension work. They survive while the current Pi process/session is running; they are
cancelled on session shutdown and are not a persistent scheduler.
