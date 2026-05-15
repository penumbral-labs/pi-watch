import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import activate from "../src/index.ts";
import {
  createBackgroundWaitRegistry,
  describeWatch,
  describeWatchResult,
  watchFile,
  WatchCancelledError,
  WatchTimeoutError,
} from "../src/core.js";

// ── Helpers ──────────────────────────────────────────────────────────

function piMock() {
  const tools = [];
  const handlers = new Map();
  const messages = [];
  return {
    tools,
    handlers,
    messages,
    registerTool(tool) {
      tools.push(tool);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    sendMessage(message, options) {
      messages.push({ message, options });
    },
    sendUserMessage(text, options) {
      messages.push({ message: { content: text }, options });
    },
  };
}

function allWatchesStatus(registry) {
  return registry.list().map((w) => ({ id: w.id, group: w.group, status: w.status, superseded: w.superseded, cancelledReason: w.cancelledReason }));
}

function onlyActive(registry) {
  return registry.list({ includeCompleted: false });
}

async function waitForEvents(messages, count, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (messages.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ── Group / Supersede ───────────────────────────────────────────────

test("supersedeGroup cancels existing group watches and suppresses their notifications", async () => {
  const events = [];
  const registry = createBackgroundWaitRegistry({ notify: (event) => events.push(event) });

  // Start first watcher in group "run-1" that runs indefinitely
  const w1 = registry.start({
    kind: "watch_file",
    group: "run-1",
    label: "log watcher",
    target: "/tmp/run-1.log",
    run: async (_signal, _onProgress) => {
      // Never resolves naturally — simulates a long-running watch
      await new Promise(() => {});
    },
  });

  assert.equal(w1.status, "running");
  assert.equal(w1.group, "run-1");
  // Type-prefixed global monotonic ID
  assert.match(w1.id, /^file-\d+$/);

  // Start a second with supersedeGroup
  const w2 = registry.start({
    kind: "watch_file",
    group: "run-1",
    label: "log watcher rerun",
    target: "/tmp/run-1-rerun.log",
    supersedeGroup: true,
    run: async (_signal, onProgress) => {
      onProgress({ attempts: 1, elapsedMs: 0, message: "waiting" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { done: true, message: "ready" };
    },
  });

  assert.equal(w2.status, "running");
  assert.equal(w2.supersededIds?.length, 1);
  assert.equal(w2.supersededIds[0], w1.id);

  // Wait for w2 to complete
  while (events.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

  // Only w2's completion event should fire
  assert.equal(events.length, 1);
  assert.equal(events[0].id, w2.id);
  assert.equal(events[0].status, "completed");

  // w1 should be recorded as superseded, not active
  const all = registry.list();
  const w1a = all.find((w) => w.id === w1.id);
  assert.ok(w1a, "w1 should be in completed history");
  assert.equal(w1a.status, "cancelled");
  assert.equal(w1a.cancelledReason, "superseded");
  assert.equal(w1a.supersededBy, w2.id);
  assert.equal(w1a.superseded, true);
});

test("superseded watch timeouts do not notify", async () => {
  const events = [];
  const registry = createBackgroundWaitRegistry({ notify: (event) => events.push(event) });

  // Start watcher that will eventually timeout
  registry.start({
    kind: "watch_file",
    group: "batch-1",
    label: "slow watcher",
    run: async () => {
      throw new WatchTimeoutError("timed out after 5ms");
    },
  });

  // Immediately supersede
  const w2 = registry.start({
    kind: "watch_file",
    group: "batch-1",
    label: "fast watcher",
    supersedeGroup: true,
    run: async (_signal, onProgress) => {
      onProgress({ attempts: 1, elapsedMs: 0, message: "waiting" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { done: true, message: "done" };
    },
  });

  while (events.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

  // Only w2 should notify — w1's timeout is suppressed
  const completedIds = events.map((e) => e.id);
  assert.ok(completedIds.includes(w2.id));
  assert.ok(!completedIds.includes(registry.list().find((w) => w.label === "slow watcher")?.id));
});

test("supersedeGroup with no existing group watches starts cleanly", async () => {
  const events = [];
  const registry = createBackgroundWaitRegistry({ notify: (event) => events.push(event) });

  const w = registry.start({
    kind: "wait_for_pid",
    group: "fresh-group",
    label: "pid check",
    supersedeGroup: true,
    run: async (_signal, onProgress) => {
      onProgress({ attempts: 1, elapsedMs: 0, message: "checking" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { done: true, message: "done" };
    },
  });

  assert.equal(w.supersededIds, undefined);
  assert.equal(w.status, "running");
});

// ── fromNow file matching ───────────────────────────────────────────

test("watchFile fromNow does not fire on pre-existing matching content", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watch-"));
  const file = path.join(dir, "log.txt");

  // Write matching content BEFORE starting watch
  fs.writeFileSync(file, "trigger word present at start");

  // Start watch with fromNow: true and a short timeout
  await assert.rejects(
    watchFile({
      path: file,
      contentIncludes: "trigger word",
      fromNow: true,
      pollMs: 25,
      timeoutMs: 150,
    }),
    /timed out/,
  );

  // Now append new content AFTER watch would have started
  // (this test runs foreground, so the rejection already proves fromNow works)
});

test("watchFile fromNow does fire when new content is appended after watch start", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watch-"));
  const file = path.join(dir, "log.txt");

  // Write content BEFORE watch
  fs.writeFileSync(file, "preamble line\n");

  // Append new matching content AFTER a small delay
  setTimeout(() => fs.appendFileSync(file, "MATCH_ME after start\n"), 80);

  const result = await watchFile({
    path: file,
    contentIncludes: "MATCH_ME",
    fromNow: true,
    pollMs: 25,
    timeoutMs: 2000,
  });

  assert.equal(result.done, true);
});

test("watchFile without fromNow fires immediately on existing content (backward compat)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watch-"));
  const file = path.join(dir, "log.txt");
  fs.writeFileSync(file, "immediate match");

  const result = await watchFile({
    path: file,
    contentIncludes: "immediate match",
    pollMs: 25,
    timeoutMs: 500,
  });

  assert.equal(result.done, true);
  assert.ok(result.elapsedMs < 100); // Should be near-instant
});

// ── Cancel watch ────────────────────────────────────────────────────

test("cancelWatch prevents notification and marks as manually cancelled", async () => {
  const events = [];
  const registry = createBackgroundWaitRegistry({ notify: (event) => events.push(event) });

  const w = registry.start({
    kind: "wait_for_pid",
    group: "cancel-test",
    label: "long pid watch",
    target: "99999",
    run: async (_signal) => {
      await new Promise(() => {}); // never resolves
    },
  });

  assert.equal(w.status, "running");

  // Cancel it
  const result = registry.cancelWatch(w.id);
  assert.equal(result, true);

  // Should be cancelled, not in active list
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(events.length, 0, "cancelWatch should suppress notification");

  const cancelled = registry.list().find((cw) => cw.id === w.id);
  assert.ok(cancelled, "cancelled watch should appear in completed history");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelledReason, "manual");
});

test("cancelWatch on non-existent ID returns false", async () => {
  const registry = createBackgroundWaitRegistry({});
  assert.equal(registry.cancelWatch("pid-99999"), false);
});

test("cancelGroup cancels all active watches in that group", async () => {
  const events = [];
  const registry = createBackgroundWaitRegistry({ notify: (event) => events.push(event) });

  // Start 3 watches in group "batch"
  for (let i = 0; i < 3; i++) {
    registry.start({
      kind: "watch_file",
      group: "batch",
      label: `file-watch-${i}`,
      run: async () => { await new Promise(() => {}); },
    });
  }
  // Start 1 in a different group
  registry.start({
    kind: "watch_file",
    group: "other",
    label: "other-watch",
    run: async () => { await new Promise(() => {}); },
  });

  const activeBefore = onlyActive(registry);
  assert.equal(activeBefore.length, 4);

  const count = registry.cancelGroup("batch");
  assert.equal(count, 3);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(events.length, 0, "cancelGroup should suppress notifications");

  const activeAfter = onlyActive(registry);
  assert.equal(activeAfter.length, 1);
  assert.equal(activeAfter[0].group, "other");

  // Check completed history for cancelled ones
  const all = registry.list();
  const cancelled = all.filter((w) => w.group === "batch");
  assert.equal(cancelled.length, 3);
  for (const c of cancelled) {
    assert.equal(c.status, "cancelled");
    assert.equal(c.cancelledReason, "manual");
  }
});

test("cancelGroup with no matching group returns 0", async () => {
  const registry = createBackgroundWaitRegistry({});
  assert.equal(registry.cancelGroup("nonexistent"), 0);
});

// ── Status / list output ────────────────────────────────────────────

test("registry.list shows mixed active and completed watches with correct statuses", async () => {
  const events = [];
  const registry = createBackgroundWaitRegistry({ notify: (event) => events.push(event) });

  // Completed normally — let it finish before starting others in the same group
  registry.start({
    kind: "wait_for_pid",
    group: "mixed",
    label: "completed-one",
    run: async () => ({ done: true, message: "ok" }),
  });
  // Wait for microtask to settle so completed-one finishes before superseder
  await new Promise((resolve) => setTimeout(resolve, 5));

  // Will be superseded
  const toSupersede = registry.start({
    kind: "watch_file",
    group: "mixed",
    label: "will-be-superseded",
    run: async () => { await new Promise(() => {}); },
  });

  // Superseder
  registry.start({
    kind: "watch_file",
    group: "mixed",
    label: "superseder",
    supersedeGroup: true,
    run: async () => ({ done: true, message: "superseded-done" }),
  });

  // Active (never finishes)
  registry.start({
    kind: "wait_for_command",
    group: "active-group",
    label: "still-running",
    run: async () => { await new Promise(() => {}); },
  });

  // Timed out
  registry.start({
    kind: "sleep_until",
    group: "timeouts",
    label: "timed-out-one",
    run: async () => { throw new WatchTimeoutError("timed out"); },
  });

  // Manually cancelled
  const toCancel = registry.start({
    kind: "wait_for_pid",
    group: "manual-cancel",
    label: "will-cancel",
    run: async () => { await new Promise(() => {}); },
  });
  registry.cancelWatch(toCancel.id);

  await new Promise((resolve) => setTimeout(resolve, 50));

  const all = registry.list();
  const statuses = allWatchesStatus(registry);

  // Active
  const active = all.filter((w) => w.status === "running");
  assert.equal(active.length, 1);
  assert.equal(active[0].group, "active-group");
  assert.equal(active[0].label, "still-running");

  // Completed
  const completed = all.filter((w) => w.status === "completed");
  assert.ok(completed.length >= 2, `expected >=2 completed, got ${completed.length}`);

  // Cancelled/superseded
  const cancelled = all.filter((w) => w.status === "cancelled");
  const supersededList = cancelled.filter((w) => w.cancelledReason === "superseded");
  const manualList = cancelled.filter((w) => w.cancelledReason === "manual");
  assert.equal(supersededList.length, 1, `expected 1 superseded, got ${supersededList.length}`);
  assert.equal(manualList.length, 1, `expected 1 manual cancel, got ${manualList.length}`);

  // Timed out
  const timedOut = all.filter((w) => w.status === "timed_out");
  assert.equal(timedOut.length, 1);
});

test("describeWatchResult distinguishes notification types", () => {
  const supersededEvent = {
    id: "file-1", kind: "watch_file", group: "run-A", label: "log watcher", target: "/tmp/a.log",
    status: "cancelled", superseded: true, supersededBy: "file-5",
  };
  const supersededResult = describeWatchResult(supersededEvent);
  assert.match(supersededResult, /stale.*superseded/);
  assert.match(supersededResult, /file-5/);

  const manuallyCancelled = {
    id: "pid-3", kind: "wait_for_pid", group: "run-B", label: "pid watcher", target: "12345",
    status: "cancelled", cancelledReason: "manual",
  };
  const cancelResult = describeWatchResult(manuallyCancelled);
  assert.match(cancelResult, /manually cancelled/);

  const completed = {
    id: "pid-4", kind: "wait_for_pid", label: "pid check", target: "12345",
    status: "completed", message: "pid 12345 exited", elapsedMs: 500,
  };
  const completedResult = describeWatchResult(completed);
  assert.match(completedResult, /completed/);
  assert.match(completedResult, /after 500ms/);

  const timedOut = {
    id: "file-6", kind: "watch_file", group: "run-C", label: "slow file", target: "/tmp/slow.log",
    status: "timed_out", elapsedMs: 10000,
  };
  const timeoutResult = describeWatchResult(timedOut);
  assert.match(timeoutResult, /timed out/);
  assert.match(timeoutResult, /\[run-C\]/);
});

// ── Type-prefixed IDs ────────────────────────────────────────────────

test("watch IDs use type-prefixed globally monotonic format", () => {
  const registry = createBackgroundWaitRegistry({});

  const pid = registry.start({
    kind: "wait_for_pid", label: "p", run: async () => { await new Promise(() => {}); },
  });
  const file = registry.start({
    kind: "watch_file", label: "f", run: async () => { await new Promise(() => {}); },
  });
  const cmd = registry.start({
    kind: "wait_for_command", label: "c", run: async () => { await new Promise(() => {}); },
  });
  const sleep = registry.start({
    kind: "sleep_until", label: "s", run: async () => { await new Promise(() => {}); },
  });

  assert.match(pid.id, /^pid-\d+$/);
  assert.match(file.id, /^file-\d+$/);
  assert.match(cmd.id, /^cmd-\d+$/);
  assert.match(sleep.id, /^sleep-\d+$/);

  // Global monotonic — extract numbers and verify they're sequential
  const nums = [pid, file, cmd, sleep].map((w) => parseInt(w.id.split("-")[1], 10));
  const sorted = [...nums].sort((a, b) => a - b);
  assert.deepEqual(nums, sorted, `IDs should be monotonic: ${nums.join(", ")}`);
});

// ── Extension tool integration ──────────────────────────────────────

test("extension tools accept group/label/supersedeGroup and register list/cancel tools", async () => {
  const mock = piMock();
  activate(mock);

  const toolNames = mock.tools.map((t) => t.name);
  assert.ok(toolNames.includes("wait_for_pid"));
  assert.ok(toolNames.includes("wait_for_command"));
  assert.ok(toolNames.includes("watch_file"));
  assert.ok(toolNames.includes("sleep_until"));
  assert.ok(toolNames.includes("list_watches"));
  assert.ok(toolNames.includes("cancel_watch"));
  assert.ok(toolNames.includes("cancel_group"));

  // Verify sleep_until accepts group params
  const sleepTool = mock.tools.find((t) => t.name === "sleep_until");
  const sleepSchema = sleepTool.parameters;
  assert.ok(sleepSchema.properties.group);
  assert.ok(sleepSchema.properties.label);
  assert.ok(sleepSchema.properties.supersedeGroup);

  // Verify watch_file has fromNow
  const watchTool = mock.tools.find((t) => t.name === "watch_file");
  assert.ok(watchTool.parameters.properties.fromNow);
});

test("extension tool with supersedeGroup prevents old notifications", async () => {
  const mock = piMock();
  activate(mock);

  const sleepTool = mock.tools.find((t) => t.name === "sleep_until");

  // Start first watch in group "rerun"
  await sleepTool.execute(
    "call-1",
    { isoTime: new Date(Date.now() + 50000).toISOString(), group: "rerun", label: "first" },
    undefined,
    undefined,
    {},
  );

  assert.equal(mock.messages.length, 0, "no wake message yet");

  // Start second with supersedeGroup
  await sleepTool.execute(
    "call-2",
    { isoTime: new Date(Date.now() + 30).toISOString(), group: "rerun", label: "second", supersedeGroup: true },
    undefined,
    undefined,
    {},
  );

  // Wait for the second one to complete (short sleep)
  await waitForEvents(mock.messages, 1, 2000);

  // Should get exactly ONE completion notification (the second/current one)
  const wakeMessages = mock.messages.filter((m) => m.message.customType === "pi-watch");
  assert.equal(wakeMessages.length, 1, "only the active (superseding) watch should wake");
  assert.match(wakeMessages[0].message.content, /Background wait completed/);
});

test("extension list_watches shows watches with group and status", async () => {
  const mock = piMock();
  activate(mock);

  const sleepTool = mock.tools.find((t) => t.name === "sleep_until");
  const listTool = mock.tools.find((t) => t.name === "list_watches");

  // Start a watch that will finish
  await sleepTool.execute(
    "call-1",
    { isoTime: new Date(Date.now() + 20).toISOString(), group: "list-test", label: "quick-one" },
    undefined,
    undefined,
    {},
  );

  // Start a long-running one
  await sleepTool.execute(
    "call-2",
    { isoTime: new Date(Date.now() + 50000).toISOString(), group: "list-test", label: "long-one" },
    undefined,
    undefined,
    {},
  );

  await new Promise((resolve) => setTimeout(resolve, 60));

  const result = await listTool.execute("call-3", {});
  assert.ok(result.content[0].text.includes("list-test"), "list should show group names");
  assert.match(result.content[0].text, /pid-|file-|cmd-|sleep-/, "list should show typed IDs");
});

test("extension cancel_watch cancels a specific watch", async () => {
  const mock = piMock();
  activate(mock);

  const sleepTool = mock.tools.find((t) => t.name === "sleep_until");
  const cancelTool = mock.tools.find((t) => t.name === "cancel_watch");
  const listTool = mock.tools.find((t) => t.name === "list_watches");

  const startResult = await sleepTool.execute(
    "call-1",
    { isoTime: new Date(Date.now() + 50000).toISOString(), group: "cancel-specific", label: "to-cancel" },
    undefined,
    undefined,
    {},
  );

  // Extract watchId from result text
  const watchId = startResult.details.id;

  const cancelResult = await cancelTool.execute("call-2", { id: watchId });
  assert.match(cancelResult.content[0].text, /Cancelled watch/);

  // Verify no wake notification fires
  await new Promise((resolve) => setTimeout(resolve, 50));
  const wakeMessages = mock.messages.filter((m) => m.message.customType === "pi-watch");
  assert.equal(wakeMessages.length, 0, "cancelled watch should not wake");
});

test("extension cancel_group cancels all watches in a group", async () => {
  const mock = piMock();
  activate(mock);

  const sleepTool = mock.tools.find((t) => t.name === "sleep_until");
  const cancelGroupTool = mock.tools.find((t) => t.name === "cancel_group");
  const listTool = mock.tools.find((t) => t.name === "list_watches");

  // Start 2 watches in same group
  await sleepTool.execute(
    "call-1",
    { isoTime: new Date(Date.now() + 50000).toISOString(), group: "bulk-cancel", label: "a" },
    undefined, undefined, {},
  );
  await sleepTool.execute(
    "call-2",
    { isoTime: new Date(Date.now() + 50000).toISOString(), group: "bulk-cancel", label: "b" },
    undefined, undefined, {},
  );

  const cancelResult = await cancelGroupTool.execute("call-3", { group: "bulk-cancel" });
  assert.match(cancelResult.content[0].text, /Cancelled 2 watches/);

  await new Promise((resolve) => setTimeout(resolve, 50));
  const wakeMessages = mock.messages.filter((m) => m.message.customType === "pi-watch");
  assert.equal(wakeMessages.length, 0, "cancelled group should not wake");
});

// ── Session shutdown ────────────────────────────────────────────────

test("session shutdown aborts all watchers without notification", async () => {
  const mock = piMock();
  activate(mock);

  const sleepTool = mock.tools.find((t) => t.name === "sleep_until");

  await sleepTool.execute(
    "call-1",
    { isoTime: new Date(Date.now() + 50000).toISOString(), group: "shutdown-test" },
    undefined, undefined, {},
  );

  // Trigger session shutdown
  const shutdownHandler = mock.handlers.get("session_shutdown");
  assert.ok(shutdownHandler, "session_shutdown handler should be registered");
  shutdownHandler();

  await new Promise((resolve) => setTimeout(resolve, 50));
  const wakeMessages = mock.messages.filter((m) => m.message.customType === "pi-watch");
  assert.equal(wakeMessages.length, 0, "shutdown should suppress all notifications");
});

// ── describeWatch utility ────────────────────────────────────────────

test("describeWatch includes group and stale/superseded state", () => {
  const normalWatch = { kind: "wait_for_pid", label: "my pid", target: "1234" };
  assert.match(describeWatch(normalWatch), /wait_for_pid: my pid/);

  const groupedWatch = { kind: "watch_file", group: "run-5", label: "embed check", target: "/tmp/out.log" };
  assert.match(describeWatch(groupedWatch), /\[run-5\] watch_file: embed check/);

  const staleWatch = {
    kind: "watch_file", group: "run-1", label: "old watcher",
    target: "/tmp/run-1.log", superseded: true, supersededBy: "file-42",
  };
  assert.match(describeWatch(staleWatch), /\(stale\)/);

  const supersededWatch = {
    kind: "watch_file", group: "run-1", label: "old watcher",
    target: "/tmp/run-1.log", cancelledReason: "superseded",
  };
  assert.match(describeWatch(supersededWatch), /\(superseded\)/);
});
