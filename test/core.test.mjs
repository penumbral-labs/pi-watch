import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import activate from "../src/index.ts";
import {
  createBackgroundWaitRegistry,
  waitForPid,
  waitForCommand,
  watchFile,
  WatchCancelledError,
  WatchTimeoutError,
} from "../src/core.js";

test("waitForPid resumes after short-lived process exits", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 120)"], { stdio: "ignore" });
  const result = await waitForPid({ pid: child.pid, pollMs: 25, timeoutMs: 2000 });
  assert.equal(result.done, true);
  assert.ok(result.elapsedMs >= 0);
});

test("waitForCommand succeeds after command condition becomes true", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watch-"));
  const file = path.join(dir, "ready");
  setTimeout(() => fs.writeFileSync(file, "ok"), 120);
  const result = await waitForCommand({ command: `test -f ${JSON.stringify(file)}`, intervalMs: 50, timeoutMs: 2000 });
  assert.equal(result.commandResult.exitCode, 0);
});

test("waitForCommand times out", async () => {
  await assert.rejects(
    waitForCommand({ command: "exit 1", intervalMs: 25, timeoutMs: 100 }),
    /timed out/,
  );
});

test("watchFile completes when content appears", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watch-"));
  const file = path.join(dir, "log.txt");
  fs.writeFileSync(file, "starting");
  setTimeout(() => fs.appendFileSync(file, "\ndone"), 120);
  const result = await watchFile({ path: file, contentIncludes: "done", pollMs: 50, timeoutMs: 2000 });
  assert.equal(result.done, true);
});

test("long wait cancels cleanly", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(
    waitForCommand({ command: "exit 1", intervalMs: 1000, timeoutMs: 5000, signal: ac.signal }),
    WatchCancelledError,
  );
});

test("background wait registry returns immediately and notifies on completion", async () => {
  const events = [];
  const registry = createBackgroundWaitRegistry({ notify: (event) => events.push(event) });

  const started = registry.start({
    kind: "test_wait",
    label: "quick condition",
    run: async (_signal, onProgress) => {
      onProgress({ attempts: 1, elapsedMs: 0, message: "waiting" });
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { done: true, message: "ready" };
    },
  });

  assert.equal(started.status, "running");
  assert.equal(started.kind, "test_wait");
  assert.equal(registry.list().length, 1);

  await assert.doesNotReject(async () => {
    while (events.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  });

  assert.equal(events[0].id, started.id);
  assert.equal(events[0].status, "completed");
  assert.equal(events[0].message, "ready");
  assert.equal(registry.list().length, 0);
});

test("background wait registry reports timeouts as wake events", async () => {
  const events = [];
  const registry = createBackgroundWaitRegistry({ notify: (event) => events.push(event) });

  registry.start({
    kind: "test_wait",
    label: "timeout condition",
    run: async () => {
      throw new WatchTimeoutError("timed out after 10ms");
    },
  });

  while (events.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(events[0].status, "timed_out");
  assert.equal(events[0].error, "timed out after 10ms");
});

test("background wait registry copies final wait metadata", async () => {
  const events = [];
  const registry = createBackgroundWaitRegistry({ notify: (event) => events.push(event) });

  registry.start({
    kind: "test_wait",
    label: "metadata condition",
    run: async () => ({ done: true, message: "ready", attempts: 3, elapsedMs: 42 }),
  });

  while (events.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(events[0].attempts, 3);
  assert.equal(events[0].elapsedMs, 42);
  assert.ok(events[0].wallElapsedMs >= 0);
});

test("background wait registry can suppress notifications on abort", async () => {
  const events = [];
  const registry = createBackgroundWaitRegistry({ notify: (event) => events.push(event) });

  registry.start({
    kind: "test_wait",
    label: "shutdown condition",
    run: async (signal) => {
      if (signal.aborted) throw new WatchCancelledError();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new WatchCancelledError()), { once: true });
      });
    },
  });

  registry.abortAll({ notify: false });
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(events.length, 0);
  assert.equal(registry.list().length, 0);
});

test("extension sleep_until defaults to background and wakes with custom message", async () => {
  const tools = [];
  const handlers = new Map();
  const messages = [];
  const pi = {
    registerTool(tool) {
      tools.push(tool);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    sendMessage(message, options) {
      messages.push({ message, options });
    },
    sendUserMessage() {
      throw new Error("sendUserMessage should only be fallback");
    },
  };

  activate(pi);
  const sleepTool = tools.find((tool) => tool.name === "sleep_until");
  assert.ok(sleepTool);

  const result = await sleepTool.execute(
    "tool-call-1",
    { isoTime: new Date(Date.now() + 25).toISOString() },
    undefined,
    undefined,
    {},
  );

  assert.match(result.content[0].text, /Started background sleep_until/);
  assert.equal(messages.length, 0);

  while (messages.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(messages[0].message.customType, "pi-watch");
  assert.match(messages[0].message.content, /Background wait completed/);
  assert.equal(messages[0].options.triggerTurn, true);
  assert.equal(messages[0].options.deliverAs, "followUp");
  handlers.get("session_shutdown")?.();
});
