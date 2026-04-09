import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

import {
  runCommand,
  sanitizeChildEnv,
  terminateProcessTree
} from "../plugins/codex/scripts/lib/process.mjs";

test("sanitizeChildEnv strips routing env and cargo target overrides", () => {
  const env = sanitizeChildEnv({
    KEEP: "ok",
    RUST_VERIFICATION_ROOT_BASE: "/tmp/root",
    RUST_VERIFICATION_REAL_CARGO: "/tmp/cargo",
    RUST_VERIFICATION_PRESERVE_ROUTING_ENV: "1",
    BOLT_RUST_VERIFICATION_ROOT: "/tmp/bolt",
    CARGO_BUILD_TARGET_DIR: "/tmp/poison"
  });

  assert.deepEqual(env, { KEEP: "ok" });
});

test("runCommand sanitizes child env before spawning", () => {
  const result = runCommand(
    process.execPath,
    [
      "-e",
      "process.stdout.write(JSON.stringify({" +
        "keep: process.env.KEEP ?? null," +
        "routing: process.env.RUST_VERIFICATION_PRESERVE_ROUTING_ENV ?? null," +
        "target: process.env.CARGO_BUILD_TARGET_DIR ?? null" +
      "}));"
    ],
    {
      env: {
        ...process.env,
        KEEP: "ok",
        RUST_VERIFICATION_PRESERVE_ROUTING_ENV: "1",
        CARGO_BUILD_TARGET_DIR: "/tmp/poison"
      }
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    keep: "ok",
    routing: null,
    target: null
  });
});

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});
