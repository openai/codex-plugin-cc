import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  isCliEntry,
  parseStopReviewOutput,
  resolveCanonicalPath
} from "../plugins/codex/scripts/stop-review-gate-hook.mjs";

const HOOK_MODULE_URL = new URL(
  "../plugins/codex/scripts/stop-review-gate-hook.mjs",
  import.meta.url
).href;
const HOOK_MODULE_PATH = fileURLToPath(HOOK_MODULE_URL);

const ESCAPE_COMMAND = "/codex:setup --disable-review-gate";

test("resolveCanonicalPath follows symlinks to the same target", () => {
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "stop-hook-canonical-"));
  const linkPath = path.join(linkDir, "stop-review-gate-hook.mjs");

  try {
    fs.symlinkSync(HOOK_MODULE_PATH, linkPath);
    assert.equal(resolveCanonicalPath(linkPath), resolveCanonicalPath(HOOK_MODULE_PATH));
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "ENOENT") {
      return;
    }
    throw error;
  } finally {
    fs.rmSync(linkDir, { recursive: true, force: true });
  }
});

test("isCliEntry treats a symlinked argv path as the hook entry", () => {
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "stop-hook-entry-"));
  const linkPath = path.join(linkDir, "stop-review-gate-hook.mjs");

  try {
    fs.symlinkSync(HOOK_MODULE_PATH, linkPath);
    assert.equal(isCliEntry(["node", linkPath], HOOK_MODULE_URL), true);
    assert.equal(isCliEntry(["node", HOOK_MODULE_PATH], HOOK_MODULE_URL), true);
    assert.equal(isCliEntry(["node", pathToFileURL(linkPath).href], HOOK_MODULE_URL), false);
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "ENOENT") {
      return;
    }
    throw error;
  } finally {
    fs.rmSync(linkDir, { recursive: true, force: true });
  }
});

test("isCliEntry returns false for imports and unrelated scripts", () => {
  assert.equal(isCliEntry(["node"], HOOK_MODULE_URL), false);
  assert.equal(
    isCliEntry(["node", fileURLToPath(import.meta.url)], HOOK_MODULE_URL),
    false
  );
});

test("parseStopReviewOutput includes escape command for empty output", () => {
  const result = parseStopReviewOutput("");
  assert.equal(result.ok, false);
  assert.match(result.reason, new RegExp(ESCAPE_COMMAND.replace("/", "\\/")));
});

test("parseStopReviewOutput includes escape command for unexpected answer", () => {
  const result = parseStopReviewOutput("maybe later");
  assert.equal(result.ok, false);
  assert.match(result.reason, new RegExp(ESCAPE_COMMAND.replace("/", "\\/")));
});

test("parseStopReviewOutput allows clean stop review", () => {
  const result = parseStopReviewOutput("ALLOW: No blocking issues found.");
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
});

test("parseStopReviewOutput omits escape command for Codex BLOCK findings", () => {
  const result = parseStopReviewOutput("BLOCK: Missing empty-state guard");
  assert.equal(result.ok, false);
  assert.match(result.reason, /still need fixes/i);
  assert.doesNotMatch(result.reason, new RegExp(ESCAPE_COMMAND.replace("/", "\\/")));
});
