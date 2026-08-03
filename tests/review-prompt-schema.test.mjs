import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROMPT = path.join(ROOT, "plugins/codex/prompts/adversarial-review.md");
const SCHEMA = path.join(ROOT, "plugins/codex/schemas/review-output.schema.json");

const prompt = fs.readFileSync(PROMPT, "utf8");
const schema = JSON.parse(fs.readFileSync(SCHEMA, "utf8"));

// The prompt tells the model to "return only valid JSON matching the provided
// schema", but the schema itself travels separately, as the outputSchema
// parameter on turn/start. Wherever that parameter does not reach the model the
// instruction points at something invisible, and the model fills the gap by
// guessing. Naming each required key in the prompt keeps the contract legible
// on its own; these tests keep the two from drifting apart as the schema grows.

test("every top-level key the schema requires is named in the review prompt", () => {
  for (const key of schema.required) {
    assert.ok(
      prompt.includes(`\`${key}\``),
      `schema requires top-level "${key}" but the prompt never names it`
    );
  }
});

test("every finding key the schema requires is named in the review prompt", () => {
  for (const key of schema.properties.findings.items.required) {
    assert.ok(
      prompt.includes(`\`${key}\``),
      `schema requires finding."${key}" but the prompt never names it`
    );
  }
});

test("the verdict values the prompt offers are the ones the schema accepts", () => {
  for (const value of schema.properties.verdict.enum) {
    assert.ok(
      prompt.includes(`\`${value}\``),
      `schema allows verdict "${value}" but the prompt never offers it`
    );
  }
});
