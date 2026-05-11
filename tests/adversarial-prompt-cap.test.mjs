import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAdversarialReviewPrompt,
  MAX_ADVERSARIAL_PROMPT_BYTES,
  MAX_ADVERSARIAL_PROMPT_CHARS
} from "../plugins/codex/scripts/codex-companion.mjs";

function makeContext(contentBytes, { mode = "branch", inputMode = "inline-diff" } = {}) {
  return {
    target: { label: "test-target", mode },
    collectionGuidance: "Use the repository context below as primary evidence.",
    content: "A".repeat(contentBytes),
    inputMode,
    diffBytes: contentBytes
  };
}

test("buildAdversarialReviewPrompt returns prompt under MAX_ADVERSARIAL_PROMPT_BYTES for small input", () => {
  const ctx = makeContext(1024);
  const prompt = buildAdversarialReviewPrompt(ctx, "review focus");
  assert.ok(prompt.includes("test-target"), "target label should be interpolated");
  assert.ok(prompt.includes("review focus"), "focus text should be interpolated");
  assert.ok(prompt.length < MAX_ADVERSARIAL_PROMPT_CHARS);
});

test("buildAdversarialReviewPrompt truncates REVIEW_INPUT when total size exceeds MAX_ADVERSARIAL_PROMPT_BYTES", () => {
  // 900KB content + template should exceed 800KB byte cap, triggering truncation
  const ctx = makeContext(900 * 1024);
  const prompt = buildAdversarialReviewPrompt(ctx, "focus");
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  const promptChars = [...prompt].length;
  assert.ok(
    promptBytes <= MAX_ADVERSARIAL_PROMPT_BYTES,
    `prompt byte size ${promptBytes} should be <= ${MAX_ADVERSARIAL_PROMPT_BYTES}`
  );
  assert.ok(
    promptChars <= MAX_ADVERSARIAL_PROMPT_CHARS,
    `prompt char count ${promptChars} should be <= ${MAX_ADVERSARIAL_PROMPT_CHARS}`
  );
});

test("buildAdversarialReviewPrompt records truncation notice when content was trimmed", () => {
  const ctx = makeContext(900 * 1024);
  const prompt = buildAdversarialReviewPrompt(ctx, "focus");
  assert.ok(
    prompt.includes("[truncated") || prompt.includes("self-collect"),
    "truncated prompt should include a truncation marker or self-collect guidance"
  );
});

test("buildAdversarialReviewPrompt falls back to self-collect when content cannot be fitted", () => {
  // 5MB content cannot fit even after aggressive truncation - should drop to self-collect mode
  const ctx = makeContext(5 * 1024 * 1024);
  const prompt = buildAdversarialReviewPrompt(ctx, "focus");
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  const promptChars = [...prompt].length;
  assert.ok(
    promptBytes <= MAX_ADVERSARIAL_PROMPT_BYTES,
    `prompt byte size ${promptBytes} should fit under cap`
  );
  assert.ok(
    promptChars <= MAX_ADVERSARIAL_PROMPT_CHARS,
    `prompt char count ${promptChars} should fit under cap`
  );
  // self-collect mode is signaled by lightweight collection guidance
  assert.ok(
    prompt.includes("lightweight summary") || prompt.includes("self-collect") || prompt.includes("[truncated"),
    "should signal lightweight / truncated mode in the prompt"
  );
});

test("buildAdversarialReviewPrompt handles multi-byte UTF-8 input within the char cap", () => {
  // Each emoji is 4 bytes in UTF-8 but counts as 2 chars in [...str].length (surrogate pair)
  // 250000 emojis = 1MB UTF-8 bytes but 500000 [...str] chars
  const emojiCount = 250000;
  const ctx = makeContext(0);
  ctx.content = "\u{1F4A9}".repeat(emojiCount);
  const prompt = buildAdversarialReviewPrompt(ctx, "focus");
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  const promptChars = [...prompt].length;
  assert.ok(
    promptBytes <= MAX_ADVERSARIAL_PROMPT_BYTES,
    `multi-byte prompt should respect byte cap (got ${promptBytes})`
  );
  assert.ok(
    promptChars <= MAX_ADVERSARIAL_PROMPT_CHARS,
    `multi-byte prompt should respect char cap (got ${promptChars})`
  );
});

test("buildAdversarialReviewPrompt preserves USER_FOCUS even when truncating", () => {
  const ctx = makeContext(900 * 1024);
  const focusText = "Focus on auth boundary";
  const prompt = buildAdversarialReviewPrompt(ctx, focusText);
  assert.ok(
    prompt.includes(focusText),
    "USER_FOCUS should never be dropped because it is small and high-signal"
  );
});

test("MAX_ADVERSARIAL_PROMPT_BYTES leaves safety margin below 1MB API input cap", () => {
  // Codex API thread input cap is 1048576 chars. We need a safety margin for system prompt overhead.
  assert.ok(MAX_ADVERSARIAL_PROMPT_BYTES <= 900 * 1024, "byte cap should leave >= ~100KB safety margin");
  assert.ok(MAX_ADVERSARIAL_PROMPT_CHARS <= 1048576, "char cap must be <= Codex API thread input cap");
});
