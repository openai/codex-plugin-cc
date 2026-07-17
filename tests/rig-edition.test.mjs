import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyQuotaError,
  isEffortValidForTier,
  makeBlockedEnvelope,
  MODEL_ALIASES,
  nextTierDown,
  parseEnvelope,
  PER_VERB_TIER_DEFAULTS,
  resolveTier,
  runTieredTurn,
  tierDefaultsForVerb,
  withQuotaFailover
} from "../plugins/codex/scripts/lib/rig-edition.mjs";
import { buildEnv, installFakeCodexExec, readInvocations } from "./fake-codex-exec-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

test("resolveTier resolves a tier alias case-insensitively", () => {
  assert.deepEqual(resolveTier("sol"), { tier: "sol", modelId: "gpt-5.6-sol" });
  assert.deepEqual(resolveTier("TERRA"), { tier: "terra", modelId: "gpt-5.6-terra" });
  assert.deepEqual(resolveTier(" luna "), { tier: "luna", modelId: "gpt-5.6-luna" });
});

test("resolveTier resolves a full model id back to its tier", () => {
  assert.deepEqual(resolveTier("gpt-5.6-sol"), { tier: "sol", modelId: "gpt-5.6-sol" });
  assert.deepEqual(resolveTier("GPT-5.6-TERRA"), { tier: "terra", modelId: "gpt-5.6-terra" });
});

test("resolveTier returns null for unknown or empty input", () => {
  assert.equal(resolveTier("gpt-4"), null);
  assert.equal(resolveTier(""), null);
  assert.equal(resolveTier(null), null);
  assert.equal(resolveTier(undefined), null);
});

test("MODEL_ALIASES matches the verified 0.144.0 catalog ids", () => {
  assert.deepEqual(MODEL_ALIASES, {
    sol: "gpt-5.6-sol",
    terra: "gpt-5.6-terra",
    luna: "gpt-5.6-luna"
  });
});

test("isEffortValidForTier allows max/ultra only on sol", () => {
  assert.equal(isEffortValidForTier("sol", "max"), true);
  assert.equal(isEffortValidForTier("sol", "ultra"), true);
  assert.equal(isEffortValidForTier("terra", "max"), false);
  assert.equal(isEffortValidForTier("luna", "ultra"), false);
  assert.equal(isEffortValidForTier("terra", "medium"), true);
  assert.equal(isEffortValidForTier("sol", "not-a-real-effort"), false);
});

test("nextTierDown steps sol -> terra -> luna -> null", () => {
  assert.equal(nextTierDown("sol"), "terra");
  assert.equal(nextTierDown("terra"), "luna");
  assert.equal(nextTierDown("luna"), null);
  assert.equal(nextTierDown("unknown-tier"), null);
});

test("tierDefaultsForVerb returns the documented per-verb defaults", () => {
  assert.deepEqual(tierDefaultsForVerb("delegate"), { tier: "terra", modelId: "gpt-5.6-terra", effort: "medium" });
  assert.deepEqual(tierDefaultsForVerb("implement"), { tier: "terra", modelId: "gpt-5.6-terra", effort: "medium" });
  assert.deepEqual(tierDefaultsForVerb("review"), { tier: "sol", modelId: "gpt-5.6-sol", effort: "high" });
  assert.deepEqual(tierDefaultsForVerb("adversarial"), { tier: "sol", modelId: "gpt-5.6-sol", effort: "high" });
  assert.deepEqual(tierDefaultsForVerb("bulk"), { tier: "luna", modelId: "gpt-5.6-luna", effort: "low" });
  assert.deepEqual(tierDefaultsForVerb("mechanical"), { tier: "luna", modelId: "gpt-5.6-luna", effort: "low" });
});

test("tierDefaultsForVerb is case-insensitive on the verb name", () => {
  assert.deepEqual(tierDefaultsForVerb("DELEGATE"), { tier: "terra", modelId: "gpt-5.6-terra", effort: "medium" });
});

test("tierDefaultsForVerb honors per-call tier and effort overrides", () => {
  assert.deepEqual(tierDefaultsForVerb("delegate", { tier: "sol", effort: "xhigh" }), {
    tier: "sol",
    modelId: "gpt-5.6-sol",
    effort: "xhigh"
  });
});

test("tierDefaultsForVerb throws on an unknown verb", () => {
  assert.throws(() => tierDefaultsForVerb("teleport"), /Unknown verb "teleport"/);
});

test("tierDefaultsForVerb throws on an unresolvable tier override", () => {
  assert.throws(() => tierDefaultsForVerb("delegate", { tier: "quasar" }), /Unknown model tier "quasar"/);
});

test("tierDefaultsForVerb throws when overriding to a sol-only effort on a lower tier", () => {
  assert.throws(
    () => tierDefaultsForVerb("delegate", { effort: "ultra" }),
    /Effort "ultra" is sol-only; tier "terra" cannot use it\./
  );
});

test("PER_VERB_TIER_DEFAULTS is frozen and covers exactly the documented verbs", () => {
  assert.deepEqual(Object.keys(PER_VERB_TIER_DEFAULTS).sort(), [
    "adversarial",
    "bulk",
    "delegate",
    "implement",
    "mechanical",
    "review"
  ]);
  assert.throws(() => {
    PER_VERB_TIER_DEFAULTS.delegate = { tier: "luna", effort: "low" };
  }, TypeError);
});

test("parseEnvelope parses a bare valid envelope", () => {
  const text = JSON.stringify({
    status: "DONE",
    summary: "Implemented the feature.",
    files_modified: ["src/app.js"],
    concerns: [],
    blocked_reason: null
  });

  const envelope = parseEnvelope(text);

  assert.equal(envelope.status, "DONE");
  assert.equal(envelope.summary, "Implemented the feature.");
  assert.deepEqual(envelope.files_modified, ["src/app.js"]);
  assert.deepEqual(envelope.concerns, []);
  assert.equal(envelope.blocked_reason, null);
});

test("parseEnvelope extracts a valid envelope wrapped in surrounding prose", () => {
  const envelopeJson = JSON.stringify({
    status: "DONE_WITH_CONCERNS",
    summary: "Migrated the schema.",
    files_modified: ["db/migrations/002.sql"],
    concerns: ["Backfill not yet verified under concurrent writes."],
    blocked_reason: null
  });
  const text = `Here is my final report.\n\n${envelopeJson}\n\nLet me know if you have questions.`;

  const envelope = parseEnvelope(text);

  assert.equal(envelope.status, "DONE_WITH_CONCERNS");
  assert.deepEqual(envelope.concerns, ["Backfill not yet verified under concurrent writes."]);
});

test("parseEnvelope returns null for garbage input without throwing", () => {
  assert.equal(parseEnvelope("not json at all"), null);
  assert.equal(parseEnvelope("{ this is not { valid json"), null);
  assert.equal(parseEnvelope(""), null);
  assert.equal(parseEnvelope(null), null);
  assert.equal(parseEnvelope(undefined), null);
});

test("parseEnvelope returns null for a JSON object with the wrong status enum value", () => {
  const text = JSON.stringify({
    status: "FINISHED",
    summary: "Done.",
    files_modified: [],
    concerns: [],
    blocked_reason: null
  });

  assert.equal(parseEnvelope(text), null);
});

test("parseEnvelope returns null when required keys are missing or extra keys are present", () => {
  const missingKey = JSON.stringify({
    status: "DONE",
    summary: "Done.",
    files_modified: [],
    concerns: []
  });
  const extraKey = JSON.stringify({
    status: "DONE",
    summary: "Done.",
    files_modified: [],
    concerns: [],
    blocked_reason: null,
    unexpected: "field"
  });

  assert.equal(parseEnvelope(missingKey), null);
  assert.equal(parseEnvelope(extraKey), null);
});

test("parseEnvelope finds the first valid envelope when multiple JSON objects are present", () => {
  const invalid = JSON.stringify({ status: "NOT_A_STATUS" });
  const valid = JSON.stringify({
    status: "NEEDS_CONTEXT",
    summary: "Need clarification.",
    files_modified: [],
    concerns: [],
    blocked_reason: null
  });
  const text = `${invalid}\n${valid}`;

  const envelope = parseEnvelope(text);

  assert.equal(envelope.status, "NEEDS_CONTEXT");
});

test("makeBlockedEnvelope builds a BLOCKED envelope with the given reason", () => {
  const envelope = makeBlockedEnvelope("QUOTA_EXHAUSTED");

  assert.equal(envelope.status, "BLOCKED");
  assert.equal(envelope.blocked_reason, "QUOTA_EXHAUSTED");
  assert.deepEqual(envelope.files_modified, []);
  assert.deepEqual(envelope.concerns, []);
  assert.match(envelope.summary, /QUOTA_EXHAUSTED/);
});

test("makeBlockedEnvelope accepts summary, filesModified, and concerns overrides", () => {
  const envelope = makeBlockedEnvelope("NEEDS_HUMAN", {
    summary: "Needs a human decision.",
    filesModified: ["src/app.js"],
    concerns: ["Ambiguous requirement."]
  });

  assert.equal(envelope.summary, "Needs a human decision.");
  assert.deepEqual(envelope.files_modified, ["src/app.js"]);
  assert.deepEqual(envelope.concerns, ["Ambiguous requirement."]);
});

test("classifyQuotaError recognizes a 429 status field", () => {
  assert.equal(classifyQuotaError({ status: 429 }), true);
  assert.equal(classifyQuotaError({ statusCode: 429 }), true);
  assert.equal(classifyQuotaError({ code: 429 }), true);
  assert.equal(classifyQuotaError({ rpcCode: 429 }), true);
});

test("classifyQuotaError recognizes rate-limit and quota messages", () => {
  assert.equal(classifyQuotaError(new Error("Rate limit exceeded, try again later.")), true);
  assert.equal(classifyQuotaError({ message: "insufficient_quota" }), true);
  assert.equal(classifyQuotaError({ error: { message: "Too Many Requests" } }), true);
  assert.equal(classifyQuotaError({ detail: "quota exceeded for this billing period" }), true);
});

test("classifyQuotaError rejects unrelated errors and empty input", () => {
  assert.equal(classifyQuotaError(new Error("ENOENT: no such file or directory")), false);
  assert.equal(classifyQuotaError({ status: 500, message: "internal error" }), false);
  assert.equal(classifyQuotaError(null), false);
  assert.equal(classifyQuotaError(undefined), false);
});

test("withQuotaFailover returns the result on first-attempt success without retrying", async () => {
  const calls = [];
  const result = await withQuotaFailover(async (context) => {
    calls.push(context);
    return { ok: true, tier: context.tier };
  }, { tier: "sol" });

  assert.deepEqual(calls, [{ tier: "sol", modelId: "gpt-5.6-sol" }]);
  assert.deepEqual(result, { ok: true, tier: "sol" });
});

test("withQuotaFailover retries one tier down on a 429, then succeeds", async () => {
  const calls = [];
  const result = await withQuotaFailover(async (context) => {
    calls.push(context.tier);
    if (context.tier === "sol") {
      const error = new Error("rate limited");
      error.status = 429;
      throw error;
    }
    return { ok: true, tier: context.tier };
  }, { tier: "sol" });

  assert.deepEqual(calls, ["sol", "terra"]);
  assert.deepEqual(result, { ok: true, tier: "terra" });
});

test("withQuotaFailover returns a QUOTA_EXHAUSTED BLOCKED envelope after two consecutive 429s", async () => {
  const calls = [];
  const result = await withQuotaFailover(async (context) => {
    calls.push(context.tier);
    const error = new Error("rate limited");
    error.status = 429;
    throw error;
  }, { tier: "sol" });

  assert.deepEqual(calls, ["sol", "terra"]);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.blocked_reason, "QUOTA_EXHAUSTED");
});

test("withQuotaFailover returns QUOTA_EXHAUSTED immediately when starting at the lowest tier", async () => {
  const calls = [];
  const result = await withQuotaFailover(async (context) => {
    calls.push(context.tier);
    const error = new Error("rate limited");
    error.status = 429;
    throw error;
  }, { tier: "luna" });

  assert.deepEqual(calls, ["luna"]);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.blocked_reason, "QUOTA_EXHAUSTED");
});

test("withQuotaFailover rethrows non-quota errors without retrying", async () => {
  const calls = [];
  await assert.rejects(
    withQuotaFailover(async (context) => {
      calls.push(context.tier);
      throw new Error("unrelated failure");
    }, { tier: "sol" }),
    /unrelated failure/
  );

  assert.deepEqual(calls, ["sol"]);
});

test("withQuotaFailover rejects an unresolvable starting tier", async () => {
  await assert.rejects(withQuotaFailover(async () => ({}), { tier: "not-a-tier" }), /Unknown model tier "not-a-tier"/);
});

test("runTieredTurn reclassifies a real exec 429 so quota failover steps down a tier, then returns QUOTA_EXHAUSTED", async () => {
  // core-review BLOCKING 2: runExecTurn resolves (never rejects) on a
  // failed turn, so a real 429 must be reclassified into a thrown error
  // inside runTieredTurn's withQuotaFailover closure or the step-down never
  // fires. This drives the real exec transport against a fake codex exec
  // binary (never a live call) so the fix is exercised end to end, not just
  // asserted against a mock.
  const binDir = makeTempDir();
  installFakeCodexExec(binDir, "rate-limited");
  const cwd = makeTempDir();

  const result = await runTieredTurn(cwd, {
    tier: "sol",
    prompt: "implement the feature",
    env: buildEnv(binDir),
    pollIntervalMs: 20,
    timeoutMs: 5000
  });

  // withQuotaFailover steps down exactly one tier (sol -> terra) and gives
  // up there; this fixture rejects every model identically, so both calls
  // land in the invocation log in that order.
  assert.deepEqual(readInvocations(binDir), ["gpt-5.6-sol", "gpt-5.6-terra"]);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.blocked_reason, "QUOTA_EXHAUSTED");
});
