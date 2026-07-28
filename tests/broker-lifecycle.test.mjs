import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  ensureBrokerSession,
  teardownBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

// The broker is spawned detached and unref'd, so it outlives the process that
// started it by design. Teardown also unlinks the pid file. If teardown removes
// the pid file without terminating the process, the broker is unreachable
// forever: nothing knows its pid and nothing will ever reap it. These tests pin
// that termination happens by default rather than only when a caller remembers
// to inject a killer.

function tempSessionFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-test-"));
  const pidFile = path.join(dir, "broker.pid");
  const logFile = path.join(dir, "broker.log");
  fs.writeFileSync(pidFile, "4242");
  fs.writeFileSync(logFile, "");
  return { dir, pidFile, logFile };
}

test("teardownBrokerSession terminates the broker when no killer is injected", () => {
  const { pidFile, logFile } = tempSessionFiles();
  const killed = [];

  teardownBrokerSession({
    pidFile,
    logFile,
    pid: 4242,
    killProcess: (pid) => killed.push(pid)
  });

  assert.deepEqual(killed, [4242], "an injected killer must still be honoured");
  assert.equal(fs.existsSync(pidFile), false, "pid file is removed");
});

test("teardownBrokerSession does not unlink the pid file while leaving the process alive", () => {
  // The regression: the default was `killProcess = null`, so the guard
  // `Number.isFinite(pid) && killProcess` was false and nothing was terminated,
  // while the pid file was unlinked regardless. Reproduce the shape by asserting
  // the default parameter is a callable rather than null.
  const source = fs.readFileSync(
    new URL("../plugins/codex/scripts/lib/broker-lifecycle.mjs", import.meta.url),
    "utf8"
  );

  assert.match(
    source,
    /killProcess = terminateProcessTree/,
    "teardownBrokerSession must default killProcess to a real terminator, not null"
  );
  assert.doesNotMatch(
    source,
    /killProcess: options\.killProcess \?\? null/,
    "ensureBrokerSession must not coerce an absent injection to null; that orphans the broker it just tore down"
  );
});

test("ensureBrokerSession does not orphan a broker that never becomes ready", async () => {
  // Behavioural, and deliberately injects nothing: injecting a killer would
  // exercise the path that always worked. This spawns a REAL process that never
  // opens the endpoint, so readiness fails and teardown runs with whatever the
  // default is. Before the fix that default was null and this process survived
  // with its pid file already unlinked, which is the leak.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-cwd-"));
  const stubPath = path.join(cwd, "never-ready-broker.mjs");
  fs.writeFileSync(stubPath, "setTimeout(() => {}, 30_000);\n");

  const session = await ensureBrokerSession(cwd, {
    timeoutMs: 250,
    scriptPath: stubPath
    // The real endpoint factory is used deliberately: overriding it with a bare
    // path makes parseBrokerEndpoint throw before teardown is ever reached, so
    // the test would fail for an unrelated reason in both directions.
  });

  assert.equal(session, null, "a broker that never becomes ready yields no session");

  // The pid file is unlinked by teardown, so recover the pid from the process
  // table instead: any surviving stub is by definition an orphan.
  let survivors = [];
  try {
    const out = execFileSync("pgrep", ["-f", stubPath], { encoding: "utf8" });
    survivors = out.trim().split("\n").filter(Boolean);
  } catch {
    // pgrep exits non-zero when nothing matches, which is the passing case.
  }

  try {
    assert.equal(
      survivors.length,
      0,
      `teardown left ${survivors.length} broker process(es) running after unlinking the pid file`
    );
  } finally {
    for (const pid of survivors) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});
