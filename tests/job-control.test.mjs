import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { enrichJob, readJobProgressPreview } from "../plugins/codex/scripts/lib/job-control.mjs";
import { appendLogBlock, appendLogLine, createJobLogFile } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

test("readJobProgressPreview ignores bracketed lines inside logged message and output blocks", () => {
  const workspace = makeTempDir();
  const logFile = createJobLogFile(workspace, "task-preview", "Codex Task");

  appendLogLine(logFile, "Thread ready (thr_1).");
  appendLogLine(logFile, "Turn started (turn_1).");
  appendLogLine(logFile, "Assistant message captured: Inspecting Cargo.toml.");
  appendLogBlock(
    logFile,
    "Assistant message",
    [
      "[package]",
      'name = "demo"',
      "[P1] Missing null guard in handler",
      "[1]: https://example.com/spec",
      "[x] Verified baseline"
    ].join("\n")
  );
  appendLogLine(logFile, "[warn] Retrying transient check.");
  appendLogBlock(
    logFile,
    "Final output",
    [
      "# Codex Review",
      "- [high] Unchecked index access",
      "[2026-03-18T15:30:59.000Z] Quoted log line inside final output"
    ].join("\n")
  );

  assert.deepEqual(readJobProgressPreview(logFile, 4), [
    "Thread ready (thr_1).",
    "Turn started (turn_1).",
    "Assistant message captured: Inspecting Cargo.toml.",
    "[warn] Retrying transient check."
  ]);
  assert.deepEqual(readJobProgressPreview(logFile, 0), []);
});

test("enrichJob does not infer legacy phases from bracketed lines inside assistant message blocks", () => {
  const workspace = makeTempDir();
  const logFile = path.join(workspace, "legacy-running.log");

  appendLogLine(logFile, "Searching: auth token validation");
  appendLogBlock(
    logFile,
    "Subagent reviewer message",
    "[step 2] Applying 3 file change(s) would be risky without tests."
  );

  const enriched = enrichJob({
    id: "task-legacy",
    status: "running",
    jobClass: "task",
    logFile,
    createdAt: "2026-03-18T15:30:00.000Z",
    updatedAt: "2026-03-18T15:30:05.000Z"
  });

  assert.deepEqual(enriched.progressPreview, ["Searching: auth token validation"]);
  assert.equal(enriched.phase, "investigating");
});
