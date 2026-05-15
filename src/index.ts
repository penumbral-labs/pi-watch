import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createBackgroundWaitRegistry,
  describeWatch,
  describeWatchResult,
  resultText,
  sleepUntil,
  statusForError,
  waitForCommand,
  waitForPid,
  watchFile,
} from "./core.js";

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
  const { background: _background, group: _g, label: _l, supersedeGroup: _s, ...waitParams } = params || {};
  return waitParams;
}

function short(value: unknown, max = 120) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function backgroundPromptGuideline(toolName: string) {
  return `${toolName} starts in the background by default and wakes the agent when done; pass background:false only when the next step truly needs a blocking result in the same tool call.`;
}

// ── Shared parameter schemas ────────────────────────────────────────

const GroupParams = {
  group: Type.Optional(Type.String({ description: "Logical group name for this watch. Use when starting multiple related waits (e.g. all watchers for a particular rerun). Allows bulk cancellation via cancel_group and prevents stale notifications when superseded." })),
  label: Type.Optional(Type.String({ description: "Human-readable label for this specific watch within the group (e.g. 'embed milestone', 'pid watcher'). Appears in notifications and status listings." })),
  supersedeGroup: Type.Optional(Type.Boolean({ description: "If true, cancel all existing active watches in the same group before starting this one. Prevents stale notifications from watchers started for previous runs." })),
};

// ── Background lifecycle helpers ─────────────────────────────────────

function backgroundStarted(tool: string, watch: any) {
  return ok(
    resultText(true, `Started background ${tool}`, {
      watchId: watch.id,
      target: watch.label,
      group: watch.group,
      status: watch.status,
      supersededIds: watch.supersededIds?.length ? `cancelled ${watch.supersededIds.join(", ")}` : undefined,
      note: "The agent will be woken when this wait completes, times out, or is cancelled.",
    }),
    { ...watch, background: true },
  );
}

function backgroundWakeText(event: any) {
  // Use the rich result descriptor for superseeded / cancelled / completed distinction
  const summary = describeWatchResult(event);
  const okStatus = event.status === "completed";
  return resultText(okStatus, `Background wait ${event.status}`, {
    watchId: event.id,
    kind: event.kind,
    group: event.group,
    label: event.label,
    target: event.target,
    elapsedMs: event.elapsedMs,
    attempts: event.attempts,
    message: event.message || event.lastMessage,
    error: event.error,
    superseded: event.superseded || undefined,
    supersededBy: event.supersededBy || undefined,
    cancelledReason: event.cancelledReason || undefined,
    summary,
  });
}

// ── Activation ───────────────────────────────────────────────────────

export default function activate(pi: ExtensionAPI) {
  // Store UI reference from session_start for status line updates
  let ui: any = undefined;
  let hasUI = false;

  function activeSummary() {
    const active = backgroundWaits.list({ includeCompleted: false });
    if (active.length === 0) return undefined;
    const groups = [...new Set(active.map((w: any) => w.group).filter(Boolean))];
    const groupStr = groups.length > 0 ? groups.map((g) => `[${g}]`).join(" ") + " " : "";
    const detail = active.slice(0, 4).map((w: any) => {
      const elapsed = Math.round((Date.now() - w.startedAt) / 1000);
      return `${w.id}(${elapsed}s)`;
    }).join(" ");
    const more = active.length > 4 ? ` +${active.length - 4} more` : "";
    return `🔍 ${active.length} watch${active.length === 1 ? "" : "es"}: ${groupStr}${detail}${more}`;
  }

  function refreshUI() {
    if (!hasUI || !ui) return;
    try {
      ui.setStatus("pi-watch", activeSummary());
    } catch { /* best-effort */ }
  }

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
      // Update status line after watch completes
      refreshUI();
    },
    onChange() {
      // Update status line whenever watches start/stop
      refreshUI();
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ui = ctx.ui;
    hasUI = ctx.hasUI || false;
    refreshUI();
  });

  pi.on("session_shutdown", () => {
    backgroundWaits.abortAll({ notify: false });
  });

  // ── wait_for_pid ───────────────────────────────────────────────────

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
      ...GroupParams,
    }),
    async execute(_id, params: any, signal, onUpdate) {
      try {
        const waitParams = omitBackground(params);
        if (params.background !== false) {
          const watch = backgroundWaits.start({
            kind: "wait_for_pid",
            label: params.label || `PID ${params.pid}`,
            group: params.group,
            target: String(params.pid),
            condition: { pid: params.pid, timeoutMs: params.timeoutMs },
            supersedeGroup: params.supersedeGroup,
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

  // ── wait_for_command ───────────────────────────────────────────────

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
      ...GroupParams,
    }),
    async execute(_id, params: any, signal, onUpdate, ctx: any) {
      try {
        const waitParams = { cwd: ctx?.cwd, ...omitBackground(params) };
        if (params.background !== false) {
          const watch = backgroundWaits.start({
            kind: "wait_for_command",
            label: params.label || short(params.command),
            group: params.group,
            target: short(params.command),
            condition: { command: short(params.command), timeoutMs: params.timeoutMs },
            supersedeGroup: params.supersedeGroup,
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

  // ── watch_file ─────────────────────────────────────────────────────

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
      fromNow: Type.Optional(Type.Boolean({ description: "Only match content modified/appended after watch start. Prevents immediate fire on pre-existing matching content. Useful for log tailing where you only care about new entries." })),
      background: Type.Optional(Type.Boolean({ description: "Start in the background and wake the agent when complete (default: true)" })),
      ...GroupParams,
    }),
    async execute(_id, params: any, signal, onUpdate) {
      try {
        const waitParams = omitBackground(params);
        if (params.background !== false) {
          const watch = backgroundWaits.start({
            kind: "watch_file",
            label: params.label || params.path,
            group: params.group,
            target: params.path,
            condition: {
              path: params.path,
              minSize: params.minSize,
              contentIncludes: params.contentIncludes,
              fromNow: params.fromNow,
              modifiedAfterMs: params.modifiedAfterMs,
              timeoutMs: params.timeoutMs,
            },
            supersedeGroup: params.supersedeGroup,
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

  // ── sleep_until ────────────────────────────────────────────────────

  pi.registerTool({
    name: "sleep_until",
    label: "Sleep until",
    description: "Wait until an ISO timestamp/deadline is reached. Defaults to background mode, which returns immediately and wakes the agent at the deadline.",
    promptGuidelines: [backgroundPromptGuideline("sleep_until")],
    parameters: Type.Object({
      isoTime: Type.String({ description: "ISO timestamp or parseable date/time" }),
      timeoutMs: Type.Optional(Type.Number({ description: "Optional maximum wait time in milliseconds" })),
      background: Type.Optional(Type.Boolean({ description: "Start in the background and wake the agent when complete (default: true)" })),
      ...GroupParams,
    }),
    async execute(_id, params: any, signal, onUpdate) {
      try {
        const waitParams = omitBackground(params);
        if (params.background !== false) {
          const watch = backgroundWaits.start({
            kind: "sleep_until",
            label: params.label || params.isoTime,
            group: params.group,
            target: params.isoTime,
            condition: { isoTime: params.isoTime, timeoutMs: params.timeoutMs },
            supersedeGroup: params.supersedeGroup,
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

  // ── list_watches ───────────────────────────────────────────────────

  pi.registerTool({
    name: "list_watches",
    label: "List watches",
    description: "List all active background watches with their group, label, target, condition, and status. Use to inspect what watchers are currently running.",
    parameters: Type.Object({
      group: Type.Optional(Type.String({ description: "Filter to a specific group" })),
    }),
    async execute(_id, params: any) {
      try {
        const all = backgroundWaits.list();
        const filtered = params.group
          ? all.filter((w: any) => w.group === params.group)
          : all;

        const rows = filtered.map((w: any) => ({
          watchId: w.id,
          kind: w.kind,
          group: w.group || "-",
          label: w.label || "-",
          target: w.target || "-",
          status: w.status,
          startedAt: new Date(w.startedAt).toISOString(),
          elapsedMs: w.elapsedMs,
          attempts: w.attempts,
          lastMessage: w.lastMessage || "-",
          superseded: w.superseded || false,
          supersededBy: w.supersededBy || "-",
          cancelledReason: w.cancelledReason || "-",
        }));

        const summary = `${rows.length} watch${rows.length === 1 ? "" : "es"}${params.group ? ` in group "${params.group}"` : ""}`;

        // Render as a compact table-like text
        const lines = [
          `🔍 ${summary}`,
          "",
          `watchId       │ group       │ label          │ kind        │ status    │ elapsed │ message`,
          `──────────────┼─────────────┼────────────────┼─────────────┼───────────┼─────────┼────────`,
        ];
        for (const r of rows) {
          lines.push(
            `${r.watchId.padEnd(14)}│ ${(r.group || "-").slice(0, 11).padEnd(11)} │ ${(r.label || "-").slice(0, 14).padEnd(14)} │ ${(r.kind || "-").slice(0, 11).padEnd(11)} │ ${r.status.padEnd(9)} │ ${String(r.elapsedMs).padEnd(8)}│ ${(r.lastMessage || "-").slice(0, 40)}`,
          );
        }

        return ok(lines.join("\n"), { watches: rows, count: rows.length });
      } catch (err) {
        return fail(err);
      }
    },
  });

  // ── cancel_watch ───────────────────────────────────────────────────

  pi.registerTool({
    name: "cancel_watch",
    label: "Cancel watch",
    description: "Cancel a specific background watch by its watchId. Cancelled watches will not deliver wake-up notifications.",
    parameters: Type.Object({
      id: Type.String({ description: "Watch ID to cancel (e.g. 'pid-17', 'file-18')" }),
    }),
    async execute(_id, params: any) {
      try {
        const cancelled = backgroundWaits.cancelWatch(params.id);
        if (cancelled) {
          return ok(`Cancelled watch ${params.id}`);
        }
        return ok(`Watch ${params.id} not found or already completed`);
      } catch (err) {
        return fail(err);
      }
    },
  });

  // ── cancel_group ───────────────────────────────────────────────────

  pi.registerTool({
    name: "cancel_group",
    label: "Cancel group",
    description: "Cancel all active background watches in a group. Useful for cleaning up all watchers from a previous run when restarting.",
    parameters: Type.Object({
      group: Type.String({ description: "Group name to cancel all active watches in" }),
    }),
    async execute(_id, params: any) {
      try {
        const count = backgroundWaits.cancelGroup(params.group);
        return ok(`Cancelled ${count} watch${count === 1 ? "" : "es"} in group "${params.group}"`);
      } catch (err) {
        return fail(err);
      }
    },
  });
}
