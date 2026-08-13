import test from "node:test";
import assert from "node:assert/strict";

import {
  MCP_ELICITATION_REQUEST_METHOD,
  buildServerRequestResponse
} from "../plugins/codex/scripts/lib/app-server.mjs";

test("accepts MCP tool-call approvals so headless MCP tool calls are not denied", () => {
  const response = buildServerRequestResponse({
    id: 12,
    method: MCP_ELICITATION_REQUEST_METHOD,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "example",
      mode: "form",
      message: "Allow this tool call?",
      requestedSchema: { type: "object", properties: {} },
      _meta: { codex_approval_kind: "mcp_tool_call" }
    }
  });

  assert.deepEqual(response, {
    id: 12,
    result: { action: "accept", content: null, _meta: null }
  });
});

test("declines plain form elicitations this headless client cannot fill in", () => {
  const response = buildServerRequestResponse({
    id: 13,
    method: MCP_ELICITATION_REQUEST_METHOD,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "example",
      mode: "form",
      message: "Enter your project name",
      requestedSchema: {
        type: "object",
        properties: { project: { type: "string" } },
        required: ["project"]
      },
      _meta: null
    }
  });

  assert.equal(response.result.action, "decline");
  assert.equal(response.result.content, null);
});

test("declines URL elicitations, e.g. an auth flow nobody can complete", () => {
  const response = buildServerRequestResponse({
    id: 14,
    method: MCP_ELICITATION_REQUEST_METHOD,
    params: {
      threadId: "thread-1",
      serverName: "example",
      mode: "url",
      message: "Authorize this connector",
      url: "https://example.com/oauth",
      elicitationId: "elicit-1"
    }
  });

  assert.equal(response.result.action, "decline");
});

test("declines approvals of a kind this client does not implement", () => {
  const response = buildServerRequestResponse({
    id: 15,
    method: MCP_ELICITATION_REQUEST_METHOD,
    params: {
      serverName: "example",
      mode: "form",
      message: "Add this tool?",
      _meta: { codex_approval_kind: "tool_suggestion" }
    }
  });

  assert.equal(response.result.action, "decline");
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
    method: MCP_ELICITATION_REQUEST_METHOD,
    params: { _meta: { codex_approval_kind: "mcp_tool_call" } }
  });

  assert.equal(response.id, "elicitation-42");
  assert.equal(response.result.action, "accept");
});
