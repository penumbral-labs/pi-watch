# pi-watch

Focused Pi temporal tools for waiting across long spans.

This package intentionally does only temporal waiting. It is not a goals runner, scheduler, metrics collector, or notification bundle.

## Install

```bash
pi install ../../src/github.com/penumbral-labs/pi-watch
```

## Tools

- `wait_for_pid({ pid, pollMs?, timeoutMs? })` — wait until a local PID exits.
- `wait_for_command({ command, cwd?, intervalMs?, timeoutMs? })` — poll a command until it exits 0.
- `watch_file({ path, pollMs?, timeoutMs?, minSize?, modifiedAfterMs?, contentIncludes? })` — wait for file conditions.
- `sleep_until({ isoTime, timeoutMs? })` — wait until a deadline.

All tools are blocking: when the condition completes, the tool returns and Pi naturally resumes the agent turn. They stream progress updates while waiting and honor cancellation/timeout.

## Future work

After the blocking tools are proven, a separate background watcher registry can be considered. Goals packages should call these tools rather than duplicate temporal primitives.
