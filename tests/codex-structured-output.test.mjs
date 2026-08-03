import test from "node:test";
import assert from "node:assert/strict";

import { parseStructuredOutput } from "../plugins/codex/scripts/lib/codex.mjs";

const REVIEW = { verdict: "approve", summary: "Looks fine.", findings: [] };

test("parseStructuredOutput reads a bare JSON message", () => {
  const result = parseStructuredOutput(JSON.stringify(REVIEW));

  assert.equal(result.parseError, null);
  assert.deepEqual(result.parsed, REVIEW);
});

test("parseStructuredOutput reads JSON wrapped in a fenced code block", () => {
  const result = parseStructuredOutput("```json\n" + JSON.stringify(REVIEW) + "\n```");

  assert.equal(result.parseError, null);
  assert.deepEqual(result.parsed, REVIEW);
});

test("parseStructuredOutput reads a fence with no language tag", () => {
  const result = parseStructuredOutput("```\n" + JSON.stringify(REVIEW) + "\n```");

  assert.equal(result.parseError, null);
  assert.deepEqual(result.parsed, REVIEW);
});

test("parseStructuredOutput reads a fenced message with CRLF line endings", () => {
  const result = parseStructuredOutput("```json\r\n" + JSON.stringify(REVIEW) + "\r\n```");

  assert.equal(result.parseError, null);
  assert.deepEqual(result.parsed, REVIEW);
});

test("parseStructuredOutput keeps backticks inside string values", () => {
  const withTicks = { summary: "pass `--base main` to scope the review" };
  const result = parseStructuredOutput("```json\n" + JSON.stringify(withTicks) + "\n```");

  assert.equal(result.parseError, null);
  assert.deepEqual(result.parsed, withTicks);
});

test("parseStructuredOutput still reports malformed JSON rather than swallowing it", () => {
  const result = parseStructuredOutput('{"verdict": ');

  assert.equal(result.parsed, null);
  assert.match(result.parseError, /JSON/);
  assert.equal(result.rawOutput, '{"verdict": ');
});

test("parseStructuredOutput still reports prose that is not JSON at all", () => {
  const result = parseStructuredOutput("I was unable to complete the review.");

  assert.equal(result.parsed, null);
  assert.ok(result.parseError);
});

test("parseStructuredOutput reports an empty message with the caller's failure text", () => {
  const result = parseStructuredOutput("", { failureMessage: "no final message" });

  assert.equal(result.parsed, null);
  assert.equal(result.parseError, "no final message");
});
