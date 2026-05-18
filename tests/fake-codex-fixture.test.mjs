import test from "node:test";
import assert from "node:assert/strict";

import { setupFakeCodex } from "./fake-codex-fixture.mjs";
import { runAppServerTurn } from "../plugins/codex/scripts/lib/codex.mjs";
import { makeTempDir } from "./helpers.mjs";

test("queue-driven fake: final answer is returned via runAppServerTurn", async () => {
  const cwd = makeTempDir("codex-queue-test-");
  const handle = setupFakeCodex({ cwd });
  try {
    handle.queueTurnResponse({ finalAnswer: { text: "hi" } });

    const result = await runAppServerTurn(cwd, {
      prompt: "say hi"
    });

    assert.equal(result.finalMessage, "hi");
    assert.equal(result.status, 0);
  } finally {
    handle.close();
  }
});

test("queue-driven fake: requests are captured with params", async () => {
  const cwd = makeTempDir("codex-queue-test-");
  const handle = setupFakeCodex({ cwd });
  try {
    handle.queueTurnResponse({ finalAnswer: { text: "captured" } });

    await runAppServerTurn(cwd, {
      prompt: "check capture"
    });

    const turnStarts = handle.requests.filter((r) => r.method === "turn/start");
    assert.equal(turnStarts.length, 1);
    // Verify the captured params include the input text
    const inputTexts = turnStarts[0].params.input
      .filter((item) => item.type === "text")
      .map((item) => item.text);
    assert.ok(inputTexts.some((text) => text.includes("check capture")));
  } finally {
    handle.close();
  }
});

test("queue-driven fake: commandExecution items are emitted and captured", async () => {
  const cwd = makeTempDir("codex-queue-test-");
  const handle = setupFakeCodex({ cwd });
  try {
    handle.queueTurnResponse({
      commands: [{ command: "git diff", exitCode: 0 }],
      finalAnswer: { text: "done" }
    });

    const result = await runAppServerTurn(cwd, {
      prompt: "run commands"
    });

    assert.equal(result.finalMessage, "done");
    assert.equal(result.commandExecutions.length, 1);
    assert.equal(result.commandExecutions[0].command, "git diff");
    assert.equal(result.commandExecutions[0].exitCode, 0);
  } finally {
    handle.close();
  }
});

test("queue-driven fake: RPC error causes runAppServerTurn to reject", async () => {
  const cwd = makeTempDir("codex-queue-test-");
  const handle = setupFakeCodex({ cwd });
  try {
    handle.queueTurnRpcError({ message: "boom" });

    await assert.rejects(
      runAppServerTurn(cwd, { prompt: "should fail" }),
      (error) => {
        assert.ok(error.message.includes("boom"));
        return true;
      }
    );
  } finally {
    handle.close();
  }
});

test("queue-driven fake: soft error (turnError) is captured", async () => {
  const cwd = makeTempDir("codex-queue-test-");
  const handle = setupFakeCodex({ cwd });
  try {
    handle.queueTurnResponse({
      finalAnswer: { text: "partial" },
      turnError: { message: "soft failure" }
    });

    const result = await runAppServerTurn(cwd, {
      prompt: "trigger soft error"
    });

    // The turn still completes, but state.error is set
    assert.equal(result.finalMessage, "partial");
    assert.ok(result.error);
    assert.equal(result.error.message, "soft failure");
  } finally {
    handle.close();
  }
});
