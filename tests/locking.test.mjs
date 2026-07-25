import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  acquireLock,
  acquireLockSync,
  releaseLock
} from "../plugins/codex/scripts/lib/locking.mjs";
import { makeTempDir } from "./helpers.mjs";

test("lock records its owner privately and release removes only that generation", () => {
  const lockDir = path.join(makeTempDir(), "state.lock");
  const first = acquireLockSync(lockDir);
  const owner = JSON.parse(fs.readFileSync(first.ownerFile, "utf8"));

  assert.equal(owner.pid, process.pid);
  assert.equal(owner.token, first.token);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(lockDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(first.ownerFile).mode & 0o777, 0o600);
  }

  assert.equal(releaseLock(first), true);
  const successor = acquireLockSync(lockDir);

  assert.equal(releaseLock(first), false);
  assert.equal(fs.existsSync(successor.ownerFile), true);
  assert.throws(
    () => acquireLockSync(lockDir, { timeoutMs: 30, retryDelayMs: 5 }),
    /Timed out waiting for lock/
  );

  assert.equal(releaseLock(successor), true);
});

test("lock immediately reclaims an owner process that exited", async () => {
  const lockDir = path.join(makeTempDir(), "state.lock");
  const lockingModuleUrl = new URL(
    "../plugins/codex/scripts/lib/locking.mjs",
    import.meta.url
  ).href;

  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { acquireLockSync } from ${JSON.stringify(lockingModuleUrl)};
         acquireLockSync(${JSON.stringify(lockDir)});
         process.stdout.write("owned");`
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0 && stdout === "owned") {
        resolve();
        return;
      }
      reject(new Error(`owner failed (code=${code} signal=${signal}): ${stderr}`));
    });
  });

  const startedAt = Date.now();
  const successor = await acquireLock(lockDir, {
    timeoutMs: 500,
    staleMs: 30000,
    retryDelayMs: 5
  });
  assert.ok(Date.now() - startedAt < 500, "dead owner should be reclaimed before stale timeout");
  releaseLock(successor);
});

test("unknown lock contents fail closed", () => {
  const lockDir = path.join(makeTempDir(), "state.lock");
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, "unexpected"), "do not delete\n");

  assert.throws(
    () => acquireLockSync(lockDir, { timeoutMs: 30, staleMs: 0, retryDelayMs: 5 }),
    /Timed out waiting for lock/
  );
  assert.equal(fs.readFileSync(path.join(lockDir, "unexpected"), "utf8"), "do not delete\n");
});

test("malformed lock owners fail closed", () => {
  const owners = [
    { pid: 1.5, token: "fractional-pid", processIdentity: null },
    { pid: process.pid, token: "object-identity", processIdentity: {} }
  ];

  for (const owner of owners) {
    const lockDir = path.join(makeTempDir(), "state.lock");
    const ownerFile = path.join(lockDir, `owner-${owner.token}.json`);
    fs.mkdirSync(lockDir);
    fs.writeFileSync(ownerFile, `${JSON.stringify(owner)}\n`);

    assert.throws(
      () => acquireLockSync(lockDir, { timeoutMs: 30, staleMs: 0, retryDelayMs: 5 }),
      /Timed out waiting for lock/
    );
    assert.equal(fs.existsSync(ownerFile), true);
  }
});

test("stale legacy lock without process identity does not follow a reused PID forever", () => {
  const lockDir = path.join(makeTempDir(), "state.lock");
  const token = "legacy-owner";
  fs.mkdirSync(lockDir, { mode: 0o700 });
  fs.writeFileSync(
    path.join(lockDir, `owner-${token}.json`),
    `${JSON.stringify({
      pid: process.pid,
      token,
      createdAt: Date.now() - 60000,
      processIdentity: null
    })}\n`,
    { mode: 0o600 }
  );
  const oldTime = new Date(Date.now() - 60000);
  fs.utimesSync(lockDir, oldTime, oldTime);

  const successor = acquireLockSync(lockDir, {
    timeoutMs: 200,
    staleMs: 30000,
    retryDelayMs: 5,
    isProcessRunning: () => true
  });

  assert.notEqual(successor.token, token);
  assert.equal(releaseLock(successor), true);
});
