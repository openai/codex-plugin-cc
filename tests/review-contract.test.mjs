import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const REVIEW_SCHEMA = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8")
);
const ADVERSARIAL_PROMPT = fs.readFileSync(
  path.join(PLUGIN_ROOT, "prompts", "adversarial-review.md"),
  "utf8"
);

const VALID_BLOCKER_CLASSES = new Set([
  "runtime_or_behavioral_regression",
  "trust_or_safety",
  "contract_or_evidence",
  "architecture_or_scope"
]);
const VALID_MERGE_IMPACTS = new Set([
  "merge_blocker",
  "follow_up_debt",
  "non_blocking_polish"
]);
const FOLLOW_UP_TICKET_PATTERN = /^AET-[1-9][0-9]*$/;
const ALLOWED_FINDING_KEYS = new Set([
  "severity",
  "title",
  "body",
  "file",
  "line_start",
  "line_end",
  "confidence",
  "recommendation",
  "blocker_class",
  "merge_impact",
  "follow_up_ticket"
]);

function validateFinding(finding) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    return "finding must be an object";
  }

  for (const key of Object.keys(finding)) {
    if (!ALLOWED_FINDING_KEYS.has(key)) {
      return `unexpected key: ${key}`;
    }
  }

  if (!VALID_BLOCKER_CLASSES.has(finding.blocker_class)) {
    return "missing or invalid blocker_class";
  }
  if (!VALID_MERGE_IMPACTS.has(finding.merge_impact)) {
    return "missing or invalid merge_impact";
  }
  if (finding.merge_impact === "follow_up_debt" && !FOLLOW_UP_TICKET_PATTERN.test(finding.follow_up_ticket ?? "")) {
    return "follow_up_ticket required for follow_up_debt";
  }

  return null;
}

test("review schema keeps verdict stable while requiring disposition metadata on findings", () => {
  assert.deepEqual(REVIEW_SCHEMA.properties.verdict.enum, ["approve", "needs-attention"]);
  const findingSchema = REVIEW_SCHEMA.properties.findings.items;
  assert.equal(findingSchema.additionalProperties, false);
  assert.deepEqual(
    findingSchema.required.slice(-2),
    ["blocker_class", "merge_impact"]
  );
  assert.deepEqual(findingSchema.properties.blocker_class.enum, [
    "runtime_or_behavioral_regression",
    "trust_or_safety",
    "contract_or_evidence",
    "architecture_or_scope"
  ]);
  assert.deepEqual(findingSchema.properties.merge_impact.enum, [
    "merge_blocker",
    "follow_up_debt",
    "non_blocking_polish"
  ]);
  assert.equal(findingSchema.properties.follow_up_ticket.pattern, "^AET-[1-9][0-9]*$");
});

test("enriched needs-attention finding with follow_up_ticket satisfies the producer contract", () => {
  const finding = {
    severity: "high",
    title: "Missing empty-state guard",
    body: "The change assumes data is always present.",
    file: "src/app.js",
    line_start: 4,
    line_end: 6,
    confidence: 0.87,
    recommendation: "Handle empty collections before indexing.",
    blocker_class: "contract_or_evidence",
    merge_impact: "follow_up_debt",
    follow_up_ticket: "AET-413"
  };

  assert.equal(validateFinding(finding), null);
});

test("producer contract rejects findings without blocker_class", () => {
  const finding = {
    severity: "high",
    title: "Missing empty-state guard",
    body: "The change assumes data is always present.",
    file: "src/app.js",
    line_start: 4,
    line_end: 6,
    confidence: 0.87,
    recommendation: "Handle empty collections before indexing.",
    merge_impact: "follow_up_debt",
    follow_up_ticket: "AET-413"
  };

  assert.equal(validateFinding(finding), "missing or invalid blocker_class");
});

test("producer contract rejects findings without merge_impact", () => {
  const finding = {
    severity: "high",
    title: "Missing empty-state guard",
    body: "The change assumes data is always present.",
    file: "src/app.js",
    line_start: 4,
    line_end: 6,
    confidence: 0.87,
    recommendation: "Handle empty collections before indexing.",
    blocker_class: "contract_or_evidence"
  };

  assert.equal(validateFinding(finding), "missing or invalid merge_impact");
});

test("producer contract rejects follow_up_debt without follow_up_ticket", () => {
  const finding = {
    severity: "high",
    title: "Missing empty-state guard",
    body: "The change assumes data is always present.",
    file: "src/app.js",
    line_start: 4,
    line_end: 6,
    confidence: 0.87,
    recommendation: "Handle empty collections before indexing.",
    blocker_class: "contract_or_evidence",
    merge_impact: "follow_up_debt"
  };

  assert.equal(validateFinding(finding), "follow_up_ticket required for follow_up_debt");
});

test("adversarial prompt instructs Codex to emit the disposition contract fields", () => {
  assert.match(ADVERSARIAL_PROMPT, /Use `approve` only when `findings` is empty\./);
  assert.match(ADVERSARIAL_PROMPT, /`blocker_class`/);
  assert.match(ADVERSARIAL_PROMPT, /`merge_impact`/);
  assert.match(ADVERSARIAL_PROMPT, /`follow_up_ticket` when `merge_impact` is `follow_up_debt`/);
});
