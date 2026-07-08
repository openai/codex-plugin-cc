import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAdversarialReviewPrompt } from '../plugins/codex/scripts/codex-companion.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..', 'plugins', 'codex');
const TEMPLATE_PATH = path.join(ROOT_DIR, 'prompts', 'adversarial-review.md');
const MAX_PROMPT_BYTES = 800 * 1024;
const TEMPLATE = fs.readFileSync(TEMPLATE_PATH, 'utf8');

function buildPromptBaseline(template, label, focusText, guidance) {
  return template
    .replace('{{REVIEW_KIND}}', 'Adversarial Review')
    .replace('{{TARGET_LABEL}}', label)
    .replace('{{USER_FOCUS}}', focusText || 'No extra focus provided.')
    .replace('{{REVIEW_COLLECTION_GUIDANCE}}', guidance)
    .replace('{{REVIEW_INPUT}}', '');
}

function buildContentToHitExactCap(template, label, focusText, guidance, capBytes) {
  const basePrompt = buildPromptBaseline(template, label, focusText, guidance);
  const overhead = Buffer.byteLength(basePrompt, 'utf8');
  return 'x'.repeat(capBytes - overhead);
}

test('buildAdversarialReviewPrompt: small content passes through verbatim', () => {
  // Given
  const context = {
    target: { label: 'branch feature/x vs main' },
    collectionGuidance: 'Use the repository context below as primary evidence.',
    content: 'hello world'
  };
  const focusText = 'test focus';

  // When
  const result = buildAdversarialReviewPrompt(context, focusText);

  // Then
  assert.ok(Buffer.byteLength(result, 'utf8') < MAX_PROMPT_BYTES);
  assert.equal(result.includes('hello world'), true);
  assert.equal(result.includes('branch feature/x vs main'), true);
  assert.equal(result.includes('test focus'), true);
});

test('buildAdversarialReviewPrompt: exact cap boundary keeps full content', () => {
  // Given
  const label = 'branch feature/at-limit vs main';
  const focusText = 'focus';
  const guidance = 'Use the repository context below as primary evidence.';
  const content = buildContentToHitExactCap(TEMPLATE, label, focusText, guidance, MAX_PROMPT_BYTES);
  const context = {
    target: { label },
    collectionGuidance: guidance,
    content
  };

  // When
  const result = buildAdversarialReviewPrompt(context, focusText);

  // Then
  assert.equal(Buffer.byteLength(result, 'utf8'), MAX_PROMPT_BYTES);
  assert.equal(result.includes(content.slice(0, 100)), true);
  assert.equal(result.includes(content.slice(-100)), true);
});

test('buildAdversarialReviewPrompt: 1MB input falls back to lightweight guidance', () => {
  // Given
  const context = {
    target: { label: 'branch big vs main' },
    collectionGuidance: 'Use the repository context below as primary evidence.',
    content: 'x'.repeat(1024 * 1024)
  };
  const focusText = '';

  // When
  const result = buildAdversarialReviewPrompt(context, focusText);

  // Then
  assert.ok(Buffer.byteLength(result, 'utf8') <= MAX_PROMPT_BYTES);
  assert.equal(
    result.includes('lightweight summary') || result.includes('Inspect the target diff yourself'),
    true
  );
  assert.equal(result.includes('x'.repeat(1024 * 1024)), false);
});

test('buildAdversarialReviewPrompt: 5MB input uses truncation fallback', () => {
  // Given
  const context = {
    target: { label: 'branch huge vs main' },
    collectionGuidance: 'Use the repository context below as primary evidence.',
    content: 'x'.repeat(5 * 1024 * 1024)
  };
  const focusText = '';

  // When
  const result = buildAdversarialReviewPrompt(context, focusText);

  // Then
  assert.ok(Buffer.byteLength(result, 'utf8') <= MAX_PROMPT_BYTES);
  assert.equal(result.toLowerCase().includes('truncated'), true);
});

test('buildAdversarialReviewPrompt: utf8 byte accounting stays under cap', () => {
  // Given
  const content = 'あ'.repeat(250 * 1024);
  const context = {
    target: { label: 'branch jp vs main' },
    collectionGuidance: 'Use the repository context below as primary evidence.',
    content
  };
  const focusText = '';

  // When
  const result = buildAdversarialReviewPrompt(context, focusText);

  // Then
  assert.equal(Buffer.byteLength(content, 'utf8'), 750 * 1024);
  assert.ok(Buffer.byteLength(result, 'utf8') <= MAX_PROMPT_BYTES);
  assert.equal(result.includes('あ'), true);
});
