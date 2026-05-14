import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createBackgroundWaitRegistry, resultText, sleepUntil, waitForCommand, waitForPid, watchFile } from "./core.js";

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

function omitBackground(params: any) {
  const { background: _background, ...waitParams } = params || {};
  return waitParams;
}

function short(value: unknown, max = 120) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function backgroundStarted(tool: string, watch: any) {
  return ok(
    resultText(true, `Started background ${tool}`, {
      watchId: watch.id,
      target: watch.label,
      status: watch.status,
      note: "The agent will be woken when this wait completes, times out, or is cancelled.",
    }),
    { ...watch, background: true },
  );
}

function backgroundWakeText(event: any) {
  const okStatus = event.status === "completed";
  return resultText(okStatus, `Background wait ${event.status}`, {
    watchId: event.id,
    tool: event.kind,
    target: event.label,
    elapsedMs: event.elapsedMs,
    attempts: event.attempts,
    message: event.message || event.lastMessage,
    error: event.error,
  });
}

function backgroundPromptGuideline(toolName: string) {
  return `${toolName} starts in the background by default and wakes the agent when done; pass background:false only when the next step truly needs a blocking result in the same tool call.`;
}

export default function activate(pi: ExtensionAPI) {
  const backgroundWaits = createBackgroundWaitRegistry({
    notify(event: any) {
      const text = `[pi-watch]\n${backgroundWakeText(event)}`;
      try {
        pi.sendMessage(
          { customType: "pi-watch", content: text, display: true, details: event },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } catch {
        pi.sendUserMessage(text, { deliverAs: "followUp" });
      }
    },
  });

  pi.on("session_shutdown", () => {
    backgroundWaits.abortAll({ notify: false });
  });

  pi.registerTool({
    name: "wait_for_pid",
    label: "Wait for PID",
    description: "Wait until a local process exits. Defaults to background mode, which returns immediately and wakes the agent when the process exits.",
    promptGuidelines: [backgroundPromptGuideline("wait_for_pid")],
    parameters: Type.Object({
      pid: Type.Number({ description: "Process ID to wait for" }),
      pollMs: Type.Optional(Type.Number({ description: "Polling interval in milliseconds" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Maximum wait time in milliseconds" })),
      background: Type.Optional(Type.Boolean({ description: "Start in the background and wake the agent when complete (default: true)" })),
    }),
    async execute(_id, params: any, signal, onUpdate) {
      try {
        const waitParams = omitBackground(params);
        if (params.background !== false) {
          const watch = backgroundWaits.start({
            kind: "wait_for_pid",
            label: `PID ${params.pid}`,
            run: (backgroundSignal: AbortSignal, onProgress: any) => waitForPid({ ...waitParams, signal: backgroundSignal, onProgress }),
          });
          return backgroundStarted("wait_for_pid", watch);
        }
        const r = await waitForPid({ ...waitParams, signal, onProgress: progress(onUpdate, `pid ${params.pid}`) });
        return ok(resultText(true, `PID ${params.pid} exited`, { elapsedMs: r.elapsedMs, attempts: r.attempts }), r);
      } catch (err) {
        return fail(err);
      }
    },
  });

  pi.registerTool({
    name: "wait_for_command",
    label: "Wait for command",
    description: "Poll a shell command until it exits 0. Defaults to background mode, which returns immediately and wakes the agent when the command succeeds or times out.",
    promptGuidelines: [backgroundPromptGuideline("wait_for_command")],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to poll" }),
      cwd: Type.Optional(Type.String({ description: "Working directory" })),
      intervalMs: Type.Optional(Type.Number({ description: "Polling interval in milliseconds" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Maximum wait time in milliseconds" })),
      background: Type.Optional(Type.Boolean({ description: "Start in the background and wake the agent when complete (default: true)" })),
    }),
    async execute(_id, params: any, signal, onUpdate, ctx: any) {
      try {
        const waitParams = { cwd: ctx?.cwd, ...omitBackground(params) };
        if (params.background !== false) {
          const watch = backgroundWaits.start({
            kind: "wait_for_command",
            label: short(params.command),
            run: (backgroundSignal: AbortSignal, onProgress: any) => waitForCommand({ ...waitParams, signal: backgroundSignal, onProgress }),
          });
          return backgroundStarted("wait_for_command", watch);
        }
        const r = await waitForCommand({ ...waitParams, signal, onProgress: progress(onUpdate, "command") });
        return ok(resultText(true, "Command succeeded", { elapsedMs: r.elapsedMs, attempts: r.attempts, exitCode: r.commandResult?.exitCode }), r);
      } catch (err) {
        return fail(err);
      }
    },
  });

  pi.registerTool({
    name: "watch_file",
    label: "Watch file",
    description: "Wait until a local file exists, changes, reaches a size, or contains text. Defaults to background mode, which returns immediately and wakes the agent when matched.",
    promptGuidelines: [backgroundPromptGuideline("watch_file")],
    parameters: Type.Object({
      path: Type.String({ description: "File path to watch" }),
      pollMs: Type.Optional(Type.Number({ description: "Polling interval in milliseconds" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Maximum wait time in milliseconds" })),
      minSize: Type.Optional(Type.Number({ description: "Require file size at least this many bytes" })),
      modifiedAfterMs: Type.Optional(Type.Number({ description: "Require mtime greater than this epoch milliseconds value" })),
      contentIncludes: Type.Optional(Type.String({ description: "Require file content to include this text" })),
      background: Type.Optional(Type.Boolean({ description: "Start in the background and wake the agent when complete (default: true)" })),
    }),
    async execute(_id, params: any, signal, onUpdate) {
      try {
        const waitParams = omitBackground(params);
        if (params.background !== false) {
          const watch = backgroundWaits.start({
            kind: "watch_file",
            label: params.path,
            run: (backgroundSignal: AbortSignal, onProgress: any) => watchFile({ ...waitParams, signal: backgroundSignal, onProgress }),
          });
          return backgroundStarted("watch_file", watch);
        }
        const r = await watchFile({ ...waitParams, signal, onProgress: progress(onUpdate, `file ${params.path}`) });
        return ok(resultText(true, "File condition met", { elapsedMs: r.elapsedMs, attempts: r.attempts, file: r.file }), r);
      } catch (err) {
        return fail(err);
      }
    },
  });

  pi.registerTool({
    name: "sleep_until",
    label: "Sleep until",
    description: "Wait until an ISO timestamp/deadline is reached. Defaults to background mode, which returns immediately and wakes the agent at the deadline.",
    promptGuidelines: [backgroundPromptGuideline("sleep_until")],
    parameters: Type.Object({
      isoTime: Type.String({ description: "ISO timestamp or parseable date/time" }),
      timeoutMs: Type.Optional(Type.Number({ description: "Optional maximum wait time in milliseconds" })),
      background: Type.Optional(Type.Boolean({ description: "Start in the background and wake the agent when complete (default: true)" })),
    }),
    async execute(_id, params: any, signal, onUpdate) {
      try {
        const waitParams = omitBackground(params);
        if (params.background !== false) {
          const watch = backgroundWaits.start({
            kind: "sleep_until",
            label: params.isoTime,
            run: (backgroundSignal: AbortSignal, onProgress: any) => sleepUntil({ ...waitParams, signal: backgroundSignal, onProgress }),
          });
          return backgroundStarted("sleep_until", watch);
        }
        const r = await sleepUntil({ ...waitParams, signal, onProgress: progress(onUpdate, "sleep") });
        return ok(resultText(true, "Deadline reached", { elapsedMs: r.elapsedMs, attempts: r.attempts }), r);
      } catch (err) {
        return fail(err);
      }
    },
  });
}
