import test from "node:test";
import assert from "node:assert/strict";

import { captureTurn } from "../plugins/codex/scripts/lib/codex.mjs";

function makeStubClient() {
  const client = {
    notificationHandler: null,
    setNotificationHandler(handler) {
      this.notificationHandler = handler;
    },
    exitError: null,
    exitPromise: null,
    resolveExit: null
  };
  client.exitPromise = new Promise((resolve) => {
    client.resolveExit = resolve;
  });
  return client;
}

function finalAnswerNotification(threadId, turnId) {
  return {
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: { type: "agentMessage", id: `msg_${turnId}`, text: "final answer", phase: "final_answer" }
    }
  };
}

test("captureTurn treats a clean close after the final answer as completion, not failure", async () => {
  const client = makeStubClient();
  const promise = captureTurn(client, "thr_1", async () => ({ turn: { id: "turn_1", status: "inProgress" } }));

  // Let captureTurn record the turn id before notifications arrive.
  await new Promise((resolve) => setImmediate(resolve));
  client.notificationHandler(finalAnswerNotification("thr_1", "turn_1"));

  // The connection closes cleanly before the 250 ms inferred-completion
  // timer fires; the already-delivered final answer must win.
  client.resolveExit();

  const state = await promise;
  assert.equal(state.completed, true);
  assert.equal(state.lastAgentMessage, "final answer");
});

test("captureTurn still fails fast when the connection closes with no final answer", async () => {
  const client = makeStubClient();
  const promise = captureTurn(client, "thr_1", async () => ({ turn: { id: "turn_1", status: "inProgress" } }));

  await new Promise((resolve) => setImmediate(resolve));
  client.resolveExit();

  await assert.rejects(promise, /connection closed before the turn completed/);
});

test("captureTurn surfaces the transport error even when the final answer arrived", async () => {
  const client = makeStubClient();
  const promise = captureTurn(client, "thr_1", async () => ({ turn: { id: "turn_1", status: "inProgress" } }));

  await new Promise((resolve) => setImmediate(resolve));
  client.notificationHandler(finalAnswerNotification("thr_1", "turn_1"));

  client.exitError = new Error("codex app-server exited unexpectedly (exit 1).");
  client.resolveExit();

  await assert.rejects(promise, /exited unexpectedly/);
});
