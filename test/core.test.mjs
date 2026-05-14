import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { waitForPid, waitForCommand, watchFile, WatchCancelledError } from "../src/core.js";

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
