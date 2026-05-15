import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export class WatchTimeoutError extends Error {
  constructor(message = "wait timed out") {
    super(message);
    this.name = "WatchTimeoutError";
  }
}

export class WatchCancelledError extends Error {
  constructor(message = "wait cancelled") {
    super(message);
    this.name = "WatchCancelledError";
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new WatchCancelledError());
    let settled = false;
    const cleanup = () => signal?.removeEventListener?.("abort", onAbort);
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const timer = setTimeout(() => settle(resolve), ms);
    const onAbort = () => {
      clearTimeout(timer);
      settle(reject, new WatchCancelledError());
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function now() {
  return Date.now();
}

async function until(check, options = {}) {
  const pollMs = Math.max(25, Number(options.pollMs ?? options.intervalMs ?? 1000));
  const timeoutMs = options.timeoutMs === undefined ? undefined : Math.max(0, Number(options.timeoutMs));
  const start = now();
  let attempts = 0;
  while (true) {
    if (options.signal?.aborted) throw new WatchCancelledError();
    attempts += 1;
    const result = await check({ attempts, elapsedMs: now() - start });
    if (result?.done) return { ...result, attempts, elapsedMs: now() - start };
    const elapsed = now() - start;
    if (timeoutMs !== undefined && elapsed >= timeoutMs) {
      throw new WatchTimeoutError(`timed out after ${elapsed}ms`);
    }
    options.onProgress?.({ attempts, elapsedMs: elapsed, message: result?.message });
    const remaining = timeoutMs === undefined ? pollMs : Math.max(1, Math.min(pollMs, timeoutMs - elapsed));
    await sleep(remaining, options.signal);
  }
}

export async function waitForPid({ pid, pollMs = 1000, timeoutMs, signal, onProgress } = {}) {
  return until(
    () => {
      const alive = isPidAlive(Number(pid));
      return alive ? { done: false, message: `pid ${pid} still running` } : { done: true, message: `pid ${pid} exited` };
    },
    { pollMs, timeoutMs, signal, onProgress },
  );
}

export function runCommand(command, { cwd, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new WatchCancelledError());
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const cap = (s) => (s.length > 4000 ? `${s.slice(0, 2000)}\n…\n${s.slice(-2000)}` : s);
    const cleanup = () => signal?.removeEventListener?.("abort", onAbort);
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    child.stdout.on("data", (d) => {
      stdout = cap(stdout + d.toString());
    });
    child.stderr.on("data", (d) => {
      stderr = cap(stderr + d.toString());
    });
    const onAbort = () => {
      child.kill("SIGTERM");
      settle(reject, new WatchCancelledError());
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    child.on("error", (err) => settle(reject, err));
    child.on("close", (exitCode) => settle(resolve, { exitCode, stdout, stderr }));
  });
}

export async function waitForCommand({ command, cwd, intervalMs = 5000, timeoutMs, signal, onProgress } = {}) {
  if (!command || typeof command !== "string") throw new Error("command is required");
  let lastResult;
  const result = await until(
    async () => {
      lastResult = await runCommand(command, { cwd, signal });
      return lastResult.exitCode === 0
        ? { done: true, message: `command succeeded`, commandResult: lastResult }
        : { done: false, message: `exit ${lastResult.exitCode}`, commandResult: lastResult };
    },
    { intervalMs, timeoutMs, signal, onProgress },
  );
  return { ...result, commandResult: result.commandResult || lastResult };
}

export function fileConditionMet(filePath, condition = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (condition.exists === false) return { ok: false, reason: "exists" };
  if (condition.minSize !== undefined && stat.size < Number(condition.minSize)) return { ok: false, reason: `size ${stat.size}` };
  if (condition.modifiedAfterMs !== undefined && stat.mtimeMs <= Number(condition.modifiedAfterMs)) {
    return { ok: false, reason: "not modified yet" };
  }
  if (condition.contentIncludes !== undefined) {
    const content = fs.readFileSync(filePath, "utf8");
    if (!content.includes(String(condition.contentIncludes))) return { ok: false, reason: "content not found" };
  }
  return { ok: true, stat: { size: stat.size, mtimeMs: stat.mtimeMs } };
}

export async function watchFile({ path: filePath, pollMs = 1000, timeoutMs, exists = true, minSize, modifiedAfterMs, contentIncludes, fromNow, signal, onProgress } = {}) {
  if (!filePath || typeof filePath !== "string") throw new Error("path is required");
  // fromNow: only match content modified after watch start
  const effectiveModifiedAfter = fromNow ? Math.max(Number(modifiedAfterMs ?? 0), now()) : modifiedAfterMs;
  const condition = { exists, minSize, modifiedAfterMs: effectiveModifiedAfter, contentIncludes };
  return until(
    () => {
      const result = fileConditionMet(filePath, condition);
      return result.ok
        ? { done: true, message: `file condition met`, file: result.stat }
        : { done: false, message: result.reason };
    },
    { pollMs, timeoutMs, signal, onProgress },
  );
}

export async function sleepUntil({ isoTime, timeoutMs, signal, onProgress } = {}) {
  const target = Date.parse(String(isoTime || ""));
  if (!Number.isFinite(target)) throw new Error("isoTime must be a parseable date/time");
  const computedTimeout = Math.max(0, target - now());
  const effectiveTimeout = timeoutMs === undefined ? computedTimeout : Math.min(computedTimeout, Number(timeoutMs));
  return until(
    () => {
      const remainingMs = target - now();
      return remainingMs <= 0
        ? { done: true, message: "deadline reached" }
        : { done: false, message: `${Math.ceil(remainingMs / 1000)}s remaining` };
    },
    { pollMs: Math.min(1000, Math.max(25, effectiveTimeout || 25)), timeoutMs: effectiveTimeout + 5, signal, onProgress },
  );
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

// ── Background wait registry ────────────────────────────────────────

const KIND_PREFIX = {
  wait_for_pid: "pid",
  wait_for_command: "cmd",
  watch_file: "file",
  sleep_until: "sleep",
  wait: "watch",
};

function idPrefix(kind) {
  return KIND_PREFIX[kind] || "watch";
}

function describeTarget(record) {
  // Produce a short target identifier for notifications
  try {
    if (record.kind === "wait_for_pid") return `PID ${record.target}`;
    if (record.kind === "watch_file" && record.target) return path.basename(record.target);
  } catch { /* fall through */ }
  return record.target || record.label || "-";
}

function describeCondition(record) {
  const c = record.condition || {};
  const parts = [];
  if (c.contentIncludes !== undefined) parts.push(`contains "${String(c.contentIncludes).slice(0, 40)}"`);
  if (c.minSize !== undefined) parts.push(`>= ${c.minSize} bytes`);
  if (c.fromNow) parts.push("from now");
  if (c.modifiedAfterMs && !c.fromNow) parts.push(`modified after ${new Date(c.modifiedAfterMs).toISOString()}`);
  if (c.timeoutMs) parts.push(`timeout ${c.timeoutMs}ms`);
  return parts.join(", ") || "-";
}

export function describeWatch(record) {
  const group = record.group ? `[${record.group}] ` : "";
  const label = record.label ? record.label : describeTarget(record);
  const kind = record.kind || "wait";
  const stale = record.superseded ? " (stale)" : "";
  const cancelled = record.cancelledReason === "superseded" ? " (superseded)" :
    record.cancelledReason === "manual" ? " (cancelled)" : "";
  const suffix = stale || cancelled;
  return `${group}${kind}${suffix}: ${label}`;
}

export function describeWatchResult(record) {
  // Produces a compact one-line result string for notifications
  const group = record.group ? `[${record.group}] ` : "";
  const label = record.label || describeTarget(record);
  const kind = record.kind || "wait";

  if (record.superseded) {
    return `${group}${kind} (stale/superseded by ${record.supersededBy || "newer watch"}): ${label} — ${record.status}`;
  }
  if (record.cancelledReason === "superseded") {
    return `${group}${kind} (superseded by ${record.supersededBy || "newer watch"}): ${label} — ${record.status}`;
  }
  if (record.cancelledReason === "manual") {
    return `${group}${kind} (manually cancelled): ${label} — ${record.status}`;
  }

  const target = describeTarget(record);
  const elapsed = record.elapsedMs ? ` after ${record.elapsedMs}ms` : "";
  const msg = record.message || record.lastMessage || "";
  const cond = describeCondition(record);
  const detail = msg ? ` ${msg}` : cond ? ` (${cond})` : "";

  switch (record.status) {
    case "completed": return `${group}${kind}: ${label} (${target}) completed${elapsed}${detail}`;
    case "timed_out": return `${group}${kind}: ${label} (${target}) timed out${elapsed}`;
    case "cancelled": return `${group}${kind}: ${label} (${target}) cancelled${elapsed}`;
    case "failed": return `${group}${kind}: ${label} (${target}) failed: ${record.error || "unknown error"}`;
    default: return `${group}${kind}: ${label} (${target}) ${record.status}`;
  }
}

function snapshotWatch(record) {
  const { controller, notifyOnFinish, _finished, ...snapshot } = record;
  return snapshot;
}

export function statusForError(err) {
  if (err instanceof WatchCancelledError) return "cancelled";
  if (err instanceof WatchTimeoutError) return "timed_out";
  return "failed";
}

const MAX_COMPLETED_HISTORY = 200;

export function createBackgroundWaitRegistry({ notify, onChange } = {}) {
  const watchers = new Map();
  const completed = [];
  // Global monotonic counter — IDs are unique across all kinds
  let nextGlobalId = 1;

  function makeId(kind) {
    return `${idPrefix(kind)}-${nextGlobalId++}`;
  }

  function finish(record, status, patch = {}) {
    // Guard against double-finish: supersedeGroup/cancelWatch/cancelGroup call finish()
    // directly, and the .catch() handler may also fire when the abort triggers a rejection.
    if (record._finished) return;
    record._finished = true;
    const wallElapsedMs = now() - record.startedAt;
    record.status = status;
    record.completedAt = now();
    record.wallElapsedMs = wallElapsedMs;
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) record[key] = value;
    }
    record.elapsedMs = Number(patch.elapsedMs ?? (record.elapsedMs > 0 ? record.elapsedMs : wallElapsedMs));
    const event = snapshotWatch(record);
    watchers.delete(record.id);
    // Keep completed watches in history for list_watches
    completed.push(event);
    if (completed.length > MAX_COMPLETED_HISTORY) completed.shift();
    try { onChange?.(); } catch { /* best-effort */ }
    if (record.notifyOnFinish === false) return;
    try {
      notify?.(event);
    } catch {
      // A background wake-up must never become an unhandled watcher failure.
    }
  }

  return {
    start({ kind, label, group, target, condition, notifyOnFinish, run, supersedeGroup } = {}) {
      if (typeof run !== "function") throw new Error("background watch run function is required");
      const id = makeId(kind);

      // Supersede existing watches in the same group
      const supersededIds = [];
      if (supersedeGroup && group) {
        for (const record of watchers.values()) {
          if (record.group === group && record.status === "running") {
            record.notifyOnFinish = false;
            record.superseded = true;
            record.supersededBy = id;
            record.controller.abort();
            supersededIds.push(record.id);
            finish(record, "cancelled", { cancelledReason: "superseded", supersededBy: id });
          }
        }
      }

      const controller = new AbortController();
      const record = {
        id,
        kind: kind || "wait",
        label: label || kind || "wait",
        group: group || undefined,
        target: target || label || kind || "wait",
        condition: condition || undefined,
        status: "running",
        startedAt: now(),
        attempts: 0,
        elapsedMs: 0,
        lastMessage: undefined,
        notifyOnFinish: notifyOnFinish !== false,
        controller,
        superseded: false,
        supersededBy: undefined,
        cancelledReason: undefined,
        supersededIds: supersededIds.length > 0 ? supersededIds : undefined,
      };
      watchers.set(id, record);

      // Fire onChange after adding to map so list() sees the new watch
      try { onChange?.(); } catch { /* best-effort */ }

      const onProgress = (progress = {}) => {
        record.attempts = Number(progress.attempts ?? record.attempts ?? 0);
        record.elapsedMs = Number(progress.elapsedMs ?? now() - record.startedAt);
        record.lastMessage = progress.message;
      };

      Promise.resolve()
        .then(() => run(controller.signal, onProgress))
        .then((result) => finish(record, "completed", {
          result,
          message: result?.message,
          attempts: result?.attempts,
          elapsedMs: result?.elapsedMs,
        }))
        .catch((err) => finish(record, statusForError(err), { error: errorMessage(err), message: errorMessage(err) }));

      return snapshotWatch(record);
    },

    cancelWatch(id) {
      const record = watchers.get(id);
      if (!record) return false;
      record.notifyOnFinish = false;
      record.controller.abort();
      finish(record, "cancelled", { cancelledReason: "manual" });
      // onChange already fired in finish()
      return true;
    },

    cancelGroup(group) {
      if (!group) return 0;
      let count = 0;
      for (const record of watchers.values()) {
        if (record.group === group && record.status === "running") {
          record.notifyOnFinish = false;
          record.controller.abort();
          finish(record, "cancelled", { cancelledReason: "manual" });
          count++;
        }
      }
      if (count > 0) { try { onChange?.(); } catch { /* best-effort */ } }
      return count;
    },

    abortAll({ notify = true } = {}) {
      for (const record of watchers.values()) {
        record.notifyOnFinish = notify;
        record.controller.abort();
      }
    },

    list({ includeCompleted = true } = {}) {
      const active = [...watchers.values()].map(snapshotWatch);
      if (!includeCompleted) return active;
      // Return active first, then completed (most recent last in each group)
      return [...active, ...completed.slice(-MAX_COMPLETED_HISTORY)];
    },

    get(id) {
      const record = watchers.get(id);
      return record ? snapshotWatch(record) : undefined;
    },
  };
}

export function resultText(ok, title, details = {}) {
  const body = Object.entries(details)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("\n");
  return `${ok ? "✅" : "⚠️"} ${title}${body ? `\n${body}` : ""}`;
}
