import test from "node:test";
import assert from "node:assert/strict";

import {
  MCP_ELICITATION_REQUEST_METHOD,
  buildServerRequestResponse
} from "../plugins/codex/scripts/lib/app-server.mjs";

test("accepts MCP elicitation requests so headless MCP tool calls are not denied", () => {
  const response = buildServerRequestResponse({
    id: 12,
    method: MCP_ELICITATION_REQUEST_METHOD,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "example",
      mode: "form",
      message: "Allow this tool call?",
      requestedSchema: { type: "object", properties: {} }
    }
  });

  assert.deepEqual(response, {
    id: 12,
    result: { action: "accept", content: null, _meta: null }
  });
});

test("still rejects server requests the client does not implement", () => {
  const response = buildServerRequestResponse({
    id: "req-7",
    method: "item/tool/requestUserInput"
  });

  assert.equal(response.id, "req-7");
  assert.equal(response.result, undefined);
  assert.equal(response.error.code, -32601);
  assert.match(response.error.message, /item\/tool\/requestUserInput/);
});

test("preserves the request id type for string ids", () => {
  const response = buildServerRequestResponse({
    id: "elicitation-42",
    method: MCP_ELICITATION_REQUEST_METHOD
  });

  assert.equal(response.id, "elicitation-42");
  assert.equal(response.result.action, "accept");
});
