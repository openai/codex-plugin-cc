import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { forgetImportRecordsForSource, restoreImportRecordsForSource } from "../plugins/codex/scripts/lib/codex.mjs";

function importRecord(sourcePath, threadId) {
  return {
    source_path: sourcePath,
    content_sha256: `sha-${threadId}`,
    imported_thread_id: threadId,
    imported_at: 1,
    source_modified_at: null
  };
}

function useLedger(t, records) {
  const codexHome = makeTempDir();
  const ledgerPath = path.join(codexHome, "external_agent_session_imports.json");
  fs.writeFileSync(ledgerPath, JSON.stringify({ records, detected_connector_records: [] }, null, 2));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  t.after(() => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });
  return { codexHome, ledgerPath };
}

const threadIds = (ledgerPath) =>
  JSON.parse(fs.readFileSync(ledgerPath, "utf8")).records.map((record) => record.imported_thread_id);

test("--refresh keeps ledger records that another import adds while it rewrites the ledger", (t) => {
  const { codexHome, ledgerPath } = useLedger(t, [importRecord("/a.jsonl", "thr_a"), importRecord("/b.jsonl", "thr_b")]);

  // Codex imports for another session write the ledger without any lock. Land one of those
  // writes while the refresh is preparing its replacement file.
  const writeFileSync = fs.writeFileSync;
  let interleaved = false;
  t.mock.method(fs, "writeFileSync", (file, ...rest) => {
    if (!interleaved && String(file).startsWith(`${ledgerPath}.tmp-`)) {
      interleaved = true;
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
      ledger.records.push(importRecord("/c.jsonl", "thr_c"));
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
    }
    return writeFileSync(file, ...rest);
  });

  const result = forgetImportRecordsForSource("/a.jsonl");

  assert.equal(interleaved, true);
  assert.equal(result.removed, 1);
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.deepEqual(
    ledger.records.map((record) => record.imported_thread_id),
    ["thr_b", "thr_c"]
  );
  assert.deepEqual(ledger.detected_connector_records, []);
  const backup = JSON.parse(fs.readFileSync(result.backupPath, "utf8"));
  assert.deepEqual(
    backup.records.map((record) => record.imported_thread_id),
    ["thr_a", "thr_b", "thr_c"]
  );
  assert.deepEqual(
    fs.readdirSync(codexHome).filter((name) => name.includes(".tmp-")),
    []
  );
});

test("a failed --refresh puts the removed records back without dropping other updates", (t) => {
  const { ledgerPath } = useLedger(t, [importRecord("/a.jsonl", "thr_a"), importRecord("/b.jsonl", "thr_b")]);
  const forgotten = forgetImportRecordsForSource("/a.jsonl");
  assert.deepEqual(forgotten.removedRecords.map((record) => record.imported_thread_id), ["thr_a"]);

  // Another session imports while the refreshed import is running.
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  ledger.records.push(importRecord("/c.jsonl", "thr_c"));
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  assert.equal(restoreImportRecordsForSource("/a.jsonl", forgotten.removedRecords), true);
  assert.deepEqual(threadIds(ledgerPath), ["thr_b", "thr_c", "thr_a"]);
});

test("restoring import records leaves a record that Codex wrote for the source in place", (t) => {
  const { ledgerPath } = useLedger(t, [importRecord("/a.jsonl", "thr_new")]);

  assert.equal(restoreImportRecordsForSource("/a.jsonl", [importRecord("/a.jsonl", "thr_old")]), false);
  assert.deepEqual(threadIds(ledgerPath), ["thr_new"]);
});
