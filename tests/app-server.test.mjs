import test from "node:test";
import assert from "node:assert/strict";

import { AppServerClientBase } from "../plugins/codex/scripts/lib/app-server.mjs";

function createTestClient() {
  const client = new AppServerClientBase("/tmp");
  client.sendMessage = () => {};
  return client;
}

test("handleLine ignores pure ANSI escape sequences", () => {
  const client = createTestClient();
  let exited = false;
  client.handleExit = () => { exited = true; };

  // Bracketed paste mode enable/disable sequences.
  client.handleLine("\x1b[?2004h");
  client.handleLine("\x1b[?2004l");
  // Cursor movement.
  client.handleLine("\x1b[1;1H");

  assert.equal(exited, false, "handleExit should not be called for ANSI-only lines");
});

test("handleLine parses JSON after stripping inline ANSI escapes", () => {
  const client = createTestClient();
  let exited = false;
  let resolved = false;

  client.handleExit = () => { exited = true; };
  client.pending.set(1, {
    resolve() { resolved = true; },
    reject() {},
    method: "test"
  });

  // JSON with a leading ANSI escape injected by the terminal.
  client.handleLine('\x1b[?2004h{"id":1,"result":{"ok":true}}');

  assert.equal(exited, false, "handleExit should not be called");
  assert.equal(resolved, true, "pending request should be resolved");
});

test("handleLine still errors on genuinely invalid JSON", () => {
  const client = createTestClient();
  let exited = false;
  client.handleExit = () => { exited = true; };

  client.handleLine("{not valid json}");

  assert.equal(exited, true, "handleExit should be called for real JSON errors");
});
