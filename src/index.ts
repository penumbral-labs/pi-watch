import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resultText, sleepUntil, waitForCommand, waitForPid, watchFile } from "./core.js";

function progress(onUpdate: any, label: string) {
  return (p: any) => {
    onUpdate?.({
      content: [{ type: "text", text: `${label}: ${p.message || "waiting"} (${Math.round((p.elapsedMs || 0) / 1000)}s)` }],
      details: p,
    });
  };
}

function ok(text: string, details: unknown = {}) {
  return { content: [{ type: "text", text }], details };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: resultText(false, message) }], details: { error: message }, isError: true };
}

export default function activate(pi: ExtensionAPI) {
  pi.registerTool({
    name: "wait_for_pid",
    label: "Wait for PID",
    description: "Block until a local process exits, with progress updates, timeout, and cancellation support.",
    parameters: Type.Object({
      pid: Type.Number({ description: "Process ID to wait for" }),
      pollMs: Type.Optional(Type.Number({ description: "Polling interval in milliseconds" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Maximum wait time in milliseconds" })),
    }),
    async execute(_id, params: any, signal, onUpdate) {
      try {
        const r = await waitForPid({ ...params, signal, onProgress: progress(onUpdate, `pid ${params.pid}`) });
        return ok(resultText(true, `PID ${params.pid} exited`, { elapsedMs: r.elapsedMs, attempts: r.attempts }), r);
      } catch (err) {
        return fail(err);
      }
    },
  });

  pi.registerTool({
    name: "wait_for_command",
    label: "Wait for command",
    description: "Run a shell command repeatedly until it exits 0, or until timeout/cancellation.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to poll" }),
      cwd: Type.Optional(Type.String({ description: "Working directory" })),
      intervalMs: Type.Optional(Type.Number({ description: "Polling interval in milliseconds" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Maximum wait time in milliseconds" })),
    }),
    async execute(_id, params: any, signal, onUpdate, ctx: any) {
      try {
        const r = await waitForCommand({ cwd: ctx?.cwd, ...params, signal, onProgress: progress(onUpdate, "command") });
        return ok(resultText(true, "Command succeeded", { elapsedMs: r.elapsedMs, attempts: r.attempts, exitCode: r.commandResult?.exitCode }), r);
      } catch (err) {
        return fail(err);
      }
    },
  });

  pi.registerTool({
    name: "watch_file",
    label: "Watch file",
    description: "Block until a local file exists, changes, reaches a size, or contains text.",
    parameters: Type.Object({
      path: Type.String({ description: "File path to watch" }),
      pollMs: Type.Optional(Type.Number({ description: "Polling interval in milliseconds" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Maximum wait time in milliseconds" })),
      minSize: Type.Optional(Type.Number({ description: "Require file size at least this many bytes" })),
      modifiedAfterMs: Type.Optional(Type.Number({ description: "Require mtime greater than this epoch milliseconds value" })),
      contentIncludes: Type.Optional(Type.String({ description: "Require file content to include this text" })),
    }),
    async execute(_id, params: any, signal, onUpdate) {
      try {
        const r = await watchFile({ ...params, signal, onProgress: progress(onUpdate, `file ${params.path}`) });
        return ok(resultText(true, "File condition met", { elapsedMs: r.elapsedMs, attempts: r.attempts, file: r.file }), r);
      } catch (err) {
        return fail(err);
      }
    },
  });

  pi.registerTool({
    name: "sleep_until",
    label: "Sleep until",
    description: "Block until an ISO timestamp/deadline is reached, with timeout/cancellation support.",
    parameters: Type.Object({
      isoTime: Type.String({ description: "ISO timestamp or parseable date/time" }),
      timeoutMs: Type.Optional(Type.Number({ description: "Optional maximum wait time in milliseconds" })),
    }),
    async execute(_id, params: any, signal, onUpdate) {
      try {
        const r = await sleepUntil({ ...params, signal, onProgress: progress(onUpdate, "sleep") });
        return ok(resultText(true, "Deadline reached", { elapsedMs: r.elapsedMs, attempts: r.attempts }), r);
      } catch (err) {
        return fail(err);
      }
    },
  });
}
