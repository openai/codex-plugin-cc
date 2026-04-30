import test from "node:test";
import assert from "node:assert/strict";

import { interpolateTemplate } from "../plugins/codex/scripts/lib/prompts.mjs";

test("interpolateTemplate: replaces {{KEY}} with provided variable", () => {
  assert.equal(interpolateTemplate("Hello {{NAME}}", { NAME: "World" }), "Hello World");
});

test("interpolateTemplate: replaces multiple different keys in one pass", () => {
  const result = interpolateTemplate("{{GREETING}}, {{NAME}}!", { GREETING: "Hi", NAME: "Alice" });
  assert.equal(result, "Hi, Alice!");
});

test("interpolateTemplate: unknown key is replaced with empty string", () => {
  assert.equal(interpolateTemplate("Hello {{MISSING}}", {}), "Hello ");
});

test("interpolateTemplate: template with no placeholders is returned unchanged", () => {
  assert.equal(interpolateTemplate("no placeholders here", { KEY: "val" }), "no placeholders here");
});

test("interpolateTemplate: key appearing twice is replaced both times", () => {
  assert.equal(interpolateTemplate("{{X}} and {{X}}", { X: "ok" }), "ok and ok");
});
