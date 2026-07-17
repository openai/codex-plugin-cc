import test from "node:test";
import assert from "node:assert/strict";

import { buildCloudArgs, CLOUD_SUBCOMMANDS, runCloudCommand } from "../plugins/codex/scripts/lib/cloud.mjs";

test("CLOUD_SUBCOMMANDS matches the verified codex cloud --help surface", () => {
  assert.deepEqual(CLOUD_SUBCOMMANDS, ["exec", "status", "list", "apply", "diff"]);
});

test("buildCloudArgs rejects an unknown subcommand", () => {
  assert.throws(() => buildCloudArgs("teleport"), /Unknown "codex cloud" subcommand "teleport"/);
});

test("buildCloudArgs(exec) requires --env and maps branch/attempts/query", () => {
  assert.throws(() => buildCloudArgs("exec", {}), /requires --env/);

  assert.deepEqual(buildCloudArgs("exec", { env: "env-123" }), ["cloud", "exec", "--env", "env-123"]);

  assert.deepEqual(
    buildCloudArgs("exec", { env: "env-123", branch: "feat/x", attempts: 3, query: "fix the bug" }),
    ["cloud", "exec", "--env", "env-123", "--attempts", "3", "--branch", "feat/x", "fix the bug"]
  );
});

test("buildCloudArgs(status) requires a task id and maps it positionally", () => {
  assert.throws(() => buildCloudArgs("status", {}), /requires a task id/);
  assert.deepEqual(buildCloudArgs("status", { taskId: "task-1" }), ["cloud", "status", "task-1"]);
});

test("buildCloudArgs(list) maps env/limit/cursor/json as optional flags", () => {
  assert.deepEqual(buildCloudArgs("list", {}), ["cloud", "list"]);
  assert.deepEqual(
    buildCloudArgs("list", { env: "env-123", limit: 5, cursor: "abc", json: true }),
    ["cloud", "list", "--env", "env-123", "--limit", "5", "--cursor", "abc", "--json"]
  );
});

test("buildCloudArgs(apply) and buildCloudArgs(diff) require a task id and accept --attempt", () => {
  assert.throws(() => buildCloudArgs("apply", {}), /requires a task id/);
  assert.deepEqual(buildCloudArgs("apply", { taskId: "task-1", attempt: 2 }), ["cloud", "apply", "task-1", "--attempt", "2"]);
  assert.deepEqual(buildCloudArgs("diff", { taskId: "task-1" }), ["cloud", "diff", "task-1"]);
});

test("runCloudCommand wraps a successful CLI call in a DONE envelope", () => {
  const calls = [];
  const runCommand = (command, args, options) => {
    calls.push({ command, args, options });
    return { command, args, status: 0, signal: null, stdout: "task-1 queued\n", stderr: "", error: null };
  };

  const result = runCloudCommand("exec", { env: "env-123", query: "do the thing", cwd: "/repo", runCommand });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "codex");
  assert.deepEqual(calls[0].args, ["cloud", "exec", "--env", "env-123", "do the thing"]);
  assert.equal(calls[0].options.cwd, "/repo");
  assert.equal(result.exitStatus, 0);
  assert.equal(result.envelope.status, "DONE");
  assert.equal(result.envelope.blocked_reason, null);
});

test("runCloudCommand wraps a failing CLI call in a BLOCKED envelope with CLOUD_COMMAND_FAILED", () => {
  const runCommand = () => ({
    command: "codex",
    args: [],
    status: 1,
    signal: null,
    stdout: "",
    stderr: "task not found",
    error: null
  });

  const result = runCloudCommand("status", { taskId: "task-404", runCommand });

  assert.equal(result.exitStatus, 1);
  assert.equal(result.envelope.status, "BLOCKED");
  assert.equal(result.envelope.blocked_reason, "CLOUD_COMMAND_FAILED");
  assert.deepEqual(result.envelope.concerns, ["task not found"]);
});
