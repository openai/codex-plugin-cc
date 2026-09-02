import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { readTaskPromptInput } from "../plugins/codex/scripts/lib/task-prompt.mjs";
import { makeTempDir } from "./helpers.mjs";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

test("readTaskPromptInput verifies and decodes the same prompt-file bytes", () => {
  const cwd = makeTempDir();
  const bytes = Buffer.from("  review $HOME and `ticks`  \n", "utf8");
  fs.writeFileSync(path.join(cwd, "prompt.txt"), bytes);

  const input = readTaskPromptInput(
    cwd,
    { "prompt-file": "prompt.txt", "prompt-file-sha256": sha256(bytes).toUpperCase() },
    [],
    () => "unused"
  );

  assert.equal(input.text, bytes.toString("utf8"));
  assert.equal(input.source, "file");
  assert.equal(input.sha256, sha256(bytes));
  assert.equal(input.filePath, path.join(cwd, "prompt.txt"));
});

test("readTaskPromptInput rejects changed prompt-file bytes", () => {
  const cwd = makeTempDir();
  const approved = Buffer.from("approved prompt", "utf8");
  fs.writeFileSync(path.join(cwd, "prompt.txt"), "substituted prompt", "utf8");

  assert.throws(
    () =>
      readTaskPromptInput(
        cwd,
        { "prompt-file": "prompt.txt", "prompt-file-sha256": sha256(approved) },
        [],
        () => "unused"
      ),
    /Prompt file SHA-256 mismatch.*expected.*received/
  );
});

for (const digest of ["abc", "g".repeat(64), "a".repeat(63), "a".repeat(65)]) {
  test(`readTaskPromptInput rejects malformed digest ${digest.slice(0, 8)}`, () => {
    const cwd = makeTempDir();
    fs.writeFileSync(path.join(cwd, "prompt.txt"), "prompt", "utf8");
    assert.throws(
      () =>
        readTaskPromptInput(
          cwd,
          { "prompt-file": "prompt.txt", "prompt-file-sha256": digest },
          [],
          () => "unused"
        ),
      /exactly 64 hexadecimal characters/
    );
  });
}

test("readTaskPromptInput rejects digest without prompt-file", () => {
  assert.throws(
    () =>
      readTaskPromptInput(
        makeTempDir(),
        { "prompt-file-sha256": "a".repeat(64) },
        ["do", "not", "leak"],
        () => "unused"
      ),
    /requires `--prompt-file/
  );
});

test("readTaskPromptInput records a receipt without enforcing a digest", () => {
  const cwd = makeTempDir();
  const bytes = Buffer.from("compatible prompt", "utf8");
  fs.writeFileSync(path.join(cwd, "prompt.txt"), bytes);

  const input = readTaskPromptInput(cwd, { "prompt-file": "prompt.txt" }, [], () => "unused");
  assert.equal(input.text, "compatible prompt");
  assert.equal(input.sha256, sha256(bytes));
});

test("readTaskPromptInput preserves positional and stdin transports", () => {
  assert.deepEqual(readTaskPromptInput(makeTempDir(), {}, ["hello", "world"], () => "unused"), {
    text: "hello world",
    source: "positional",
    sha256: null,
    filePath: null
  });
  assert.deepEqual(readTaskPromptInput(makeTempDir(), {}, [], () => "stdin prompt"), {
    text: "stdin prompt",
    source: "stdin",
    sha256: null,
    filePath: null
  });
});
