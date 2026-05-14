import fs from "node:fs";
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
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new WatchCancelledError());
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
    const cap = (s) => (s.length > 4000 ? `${s.slice(0, 2000)}\n…\n${s.slice(-2000)}` : s);
    child.stdout.on("data", (d) => {
      stdout = cap(stdout + d.toString());
    });
    child.stderr.on("data", (d) => {
      stderr = cap(stderr + d.toString());
    });
    const onAbort = () => {
      child.kill("SIGTERM");
      reject(new WatchCancelledError());
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
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

export async function watchFile({ path: filePath, pollMs = 1000, timeoutMs, exists = true, minSize, modifiedAfterMs, contentIncludes, signal, onProgress } = {}) {
  if (!filePath || typeof filePath !== "string") throw new Error("path is required");
  const condition = { exists, minSize, modifiedAfterMs, contentIncludes };
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

export function resultText(ok, title, details = {}) {
  const body = Object.entries(details)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("\n");
  return `${ok ? "✅" : "⚠️"} ${title}${body ? `\n${body}` : ""}`;
}
