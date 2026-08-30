import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeImportPath,
  importedThreadIdFromCompletion,
  importFailureDetails
} from "../plugins/codex/scripts/lib/codex.mjs";

// Regression coverage for issue #618: `/codex:transfer` always fails on Windows
// because the ledger lookup can never match. Codex records paths via Rust's
// fs::canonicalize (Windows verbatim `\\?\...` prefix) while the plugin compared
// them against Node's fs.realpathSync output, which never carries that prefix.

test("normalizeImportPath makes a Windows verbatim path match its plain form", () => {
  const verbatim = String.raw`\\?\C:\Users\me\.claude\projects\p\id.jsonl`;
  const plain = String.raw`C:\Users\me\.claude\projects\p\id.jsonl`;

  const normalizedVerbatim = normalizeImportPath(verbatim);
  assert.ok(normalizedVerbatim, "verbatim path should normalize to a value");
  assert.equal(
    normalizedVerbatim,
    normalizeImportPath(plain),
    "verbatim and plain paths must normalize to the same value"
  );
  assert.equal(
    normalizedVerbatim.startsWith("\\\\?\\"),
    false,
    "the verbatim extended-length prefix must be stripped"
  );
});

test("normalizeImportPath maps a verbatim UNC path onto its plain UNC form", () => {
  const verbatim = String.raw`\\?\UNC\server\share\sess.jsonl`;
  const plain = String.raw`\\server\share\sess.jsonl`;

  assert.equal(normalizeImportPath(verbatim), normalizeImportPath(plain));
});

test("normalizeImportPath returns null for empty or non-string input", () => {
  assert.equal(normalizeImportPath(""), null);
  assert.equal(normalizeImportPath(undefined), null);
  assert.equal(normalizeImportPath(42), null);
});

test("importedThreadIdFromCompletion resolves target from the matching success", () => {
  const source = String.raw`C:\Users\me\.claude\projects\p\id.jsonl`;
  const completion = {
    itemTypeResults: [
      {
        itemType: "SESSIONS",
        successes: [
          {
            itemType: "SESSIONS",
            cwd: null,
            source: String.raw`\\?\C:\Users\me\.claude\projects\p\id.jsonl`,
            target: "019fe103-b7aa-74c1-8fb2-ef6afd58785f"
          }
        ],
        failures: []
      }
    ]
  };

  assert.equal(
    importedThreadIdFromCompletion(completion, source),
    "019fe103-b7aa-74c1-8fb2-ef6afd58785f"
  );
});

test("importedThreadIdFromCompletion falls back to the sole success target", () => {
  const completion = {
    itemTypeResults: [
      { successes: [{ source: "some/other/path.jsonl", target: "thread-xyz" }], failures: [] }
    ]
  };

  assert.equal(
    importedThreadIdFromCompletion(completion, String.raw`C:\Users\me\unrelated.jsonl`),
    "thread-xyz"
  );
});

test("importedThreadIdFromCompletion returns null when there is no target", () => {
  assert.equal(importedThreadIdFromCompletion(null, "x"), null);
  assert.equal(importedThreadIdFromCompletion({}, "x"), null);
  assert.equal(
    importedThreadIdFromCompletion(
      { itemTypeResults: [{ successes: [{ source: "x" }], failures: [] }] },
      "x"
    ),
    null
  );
});

test("importFailureDetails surfaces failure reasons and is null when there are none", () => {
  const withFailures = {
    itemTypeResults: [
      { successes: [], failures: [{ error: "boom" }, { message: "second" }] }
    ]
  };
  assert.equal(importFailureDetails(withFailures), "boom\nsecond");

  assert.equal(importFailureDetails({ itemTypeResults: [{ successes: [], failures: [] }] }), null);
  assert.equal(importFailureDetails(null), null);
});
