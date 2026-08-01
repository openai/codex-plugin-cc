import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { readLastAssistantMessage } from "../plugins/codex/scripts/lib/rollout.mjs";
import { renderStoredJobResult, storedJobHasOutput } from "../plugins/codex/scripts/lib/render.mjs";

const THREAD_ID = "019fbad1-b569-7d93-97be-1efbff2b73b2";
const TURN_ID = "019fbad1-c711-7051-b5bd-5665f2da3919";
const LATER_TURN_ID = "019fbb1d-a711-7051-b5bd-5665f2da3919";

function assistantRecord(text) {
  return {
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] }
  };
}

// The turn markers codex actually writes: only these carry `turn_id`, and the
// assistant records between them carry none.
function turnStart(turnId) {
  return { type: "event_msg", payload: { type: "task_started", turn_id: turnId } };
}

function turnEnd(turnId, lastAgentMessage = "") {
  return {
    type: "event_msg",
    payload: { type: "task_complete", turn_id: turnId, last_agent_message: lastAgentMessage }
  };
}

// Mirrors a real transcript: nested <sessions>/<YYYY>/<MM>/<DD>/rollout-<ts>-<threadId>.jsonl
// with reasoning and tool records interleaved between the assistant turns.
function writeRollout(sessionsDir, threadId, records) {
  const dir = path.join(sessionsDir, "2026", "08", "01");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-08-01T09-55-38-${threadId}.jsonl`);
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  return file;
}

test("readLastAssistantMessage returns the last assistant message of the turn, not the first", () => {
  const sessionsDir = makeTempDir();
  writeRollout(sessionsDir, THREAD_ID, [
    { type: "session_meta", payload: { id: THREAD_ID } },
    turnStart(TURN_ID),
    assistantRecord("first pass, still investigating"),
    { type: "response_item", payload: { type: "reasoning", content: [{ text: "thinking" }] } },
    { type: "response_item", payload: { type: "custom_tool_call", payload: {} } },
    assistantRecord("VERDICT: the lease is never released on cancellation"),
    { type: "event_msg", payload: { type: "token_count" } }
  ]);

  const recovered = readLastAssistantMessage(THREAD_ID, { turnId: TURN_ID, sessionsDir });

  assert.equal(recovered.text, "VERDICT: the lease is never released on cancellation");
  assert.equal(path.basename(recovered.file).endsWith(`-${THREAD_ID}.jsonl`), true);
});

// `--resume-last` reuses a thread, so a newer job appends its turn to the same
// transcript. Recovering the older job must not hand back the newer job's answer.
test("readLastAssistantMessage ignores turns belonging to another job on the same thread", () => {
  const sessionsDir = makeTempDir();
  writeRollout(sessionsDir, THREAD_ID, [
    { type: "session_meta", payload: { id: THREAD_ID } },
    turnStart(TURN_ID),
    assistantRecord("the answer this job produced"),
    turnEnd(TURN_ID),
    turnStart(LATER_TURN_ID),
    assistantRecord("a later job's answer"),
    turnEnd(LATER_TURN_ID)
  ]);

  assert.equal(
    readLastAssistantMessage(THREAD_ID, { turnId: TURN_ID, sessionsDir }).text,
    "the answer this job produced"
  );
  assert.equal(
    readLastAssistantMessage(THREAD_ID, { turnId: LATER_TURN_ID, sessionsDir }).text,
    "a later job's answer"
  );
});

// The transcript keeps codex's internal citation markup on the raw assistant record;
// `task_complete.last_agent_message` is the same answer with that stripped, and its
// presence is also the only proof the turn actually finished.
test("readLastAssistantMessage prefers the finished turn's own final message", () => {
  const sessionsDir = makeTempDir();
  writeRollout(sessionsDir, THREAD_ID, [
    turnStart(TURN_ID),
    assistantRecord("the answer<oai-mem-citation>internal</citation_entries>"),
    turnEnd(TURN_ID, "the answer")
  ]);

  const recovered = readLastAssistantMessage(THREAD_ID, { turnId: TURN_ID, sessionsDir });

  assert.equal(recovered.text, "the answer");
  assert.equal(recovered.complete, true);
});

test("readLastAssistantMessage falls back to the raw scan when the turn never completed", () => {
  const sessionsDir = makeTempDir();
  writeRollout(sessionsDir, THREAD_ID, [
    turnStart(TURN_ID),
    assistantRecord("still working on it"),
    // no task_complete: the turn was interrupted
    turnStart(LATER_TURN_ID),
    assistantRecord("a later job's answer"),
    turnEnd(LATER_TURN_ID, "a later job's answer")
  ]);

  const recovered = readLastAssistantMessage(THREAD_ID, { turnId: TURN_ID, sessionsDir });

  assert.equal(recovered.text, "still working on it");
  assert.equal(recovered.complete, false);
});

// A turn that errored records `task_complete` with a blank `last_agent_message`.
test("readLastAssistantMessage ignores a blank final message on a failed turn", () => {
  const sessionsDir = makeTempDir();
  writeRollout(sessionsDir, THREAD_ID, [
    turnStart(TURN_ID),
    assistantRecord("as far as I got"),
    // Whitespace, not "": an empty string is falsy anyway, so only this catches a
    // regression in the trim guard.
    turnEnd(TURN_ID, "   ")
  ]);

  const recovered = readLastAssistantMessage(THREAD_ID, { turnId: TURN_ID, sessionsDir });

  assert.equal(recovered.text, "as far as I got");
  assert.equal(recovered.complete, false);
});

test("readLastAssistantMessage survives the half-written final line a killed turn leaves", () => {
  const sessionsDir = makeTempDir();
  const file = writeRollout(sessionsDir, THREAD_ID, [
    turnStart(TURN_ID),
    assistantRecord("the recoverable answer")
  ]);
  fs.appendFileSync(file, '{"type":"response_item","payload":{"type":"mess', "utf8");

  assert.equal(
    readLastAssistantMessage(THREAD_ID, { turnId: TURN_ID, sessionsDir }).text,
    "the recoverable answer"
  );
});

test("readLastAssistantMessage returns null without a matching thread id or turn id", () => {
  const sessionsDir = makeTempDir();
  writeRollout(sessionsDir, "some-other-thread", [turnStart(TURN_ID), assistantRecord("not this one")]);

  assert.equal(readLastAssistantMessage(THREAD_ID, { turnId: TURN_ID, sessionsDir }), null);
  assert.equal(readLastAssistantMessage("", { turnId: TURN_ID, sessionsDir }), null);
  assert.equal(readLastAssistantMessage(null, { turnId: TURN_ID, sessionsDir }), null);
  // No turn id: the job's turn cannot be identified, so nothing is safe to return.
  assert.equal(readLastAssistantMessage("some-other-thread", { sessionsDir }), null);
  assert.equal(readLastAssistantMessage("some-other-thread", { turnId: null, sessionsDir }), null);
});

test("readLastAssistantMessage returns null when the transcript holds no assistant text", () => {
  const sessionsDir = makeTempDir();
  writeRollout(sessionsDir, THREAD_ID, [
    { type: "session_meta", payload: { id: THREAD_ID } },
    turnStart(TURN_ID),
    { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "go" }] } },
    assistantRecord("   ")
  ]);

  assert.equal(readLastAssistantMessage(THREAD_ID, { turnId: TURN_ID, sessionsDir }), null);
});

test("storedJobHasOutput distinguishes a stored result from an empty one", () => {
  assert.equal(storedJobHasOutput({ result: { rawOutput: "done" } }), true);
  assert.equal(storedJobHasOutput({ result: { codex: { stdout: "done" } } }), true);
  assert.equal(storedJobHasOutput({ rendered: "# Report" }), true);
  assert.equal(storedJobHasOutput({ result: { rawOutput: "" } }), false);
  assert.equal(storedJobHasOutput(null), false);
  // Whitespace would otherwise count as output and suppress the transcript recovery.
  assert.equal(storedJobHasOutput({ result: { rawOutput: "\n" } }), false);
  assert.equal(storedJobHasOutput({ rendered: "  \n " }), false);
});

test("renderStoredJobResult surfaces a recovered message instead of the empty-payload notice", () => {
  const job = { id: "job-1", status: "failed", threadId: THREAD_ID };
  const recovered = {
    text: "VERDICT: the lease is never released",
    complete: false,
    file: "C:/rollout.jsonl"
  };

  const rendered = renderStoredJobResult(job, null, recovered);

  assert.match(rendered, /Recovered from the Codex transcript \(PARTIAL\)/);
  assert.match(rendered, /VERDICT: the lease is never released/);
  assert.match(rendered, /C:\/rollout\.jsonl/);
  assert.doesNotMatch(rendered, /No captured result payload was stored/);
});

test("renderStoredJobResult drops the PARTIAL label when the turn did finish", () => {
  const job = { id: "job-1", status: "failed", threadId: THREAD_ID };
  const recovered = { text: "the final answer", complete: true, file: "C:/rollout.jsonl" };

  const rendered = renderStoredJobResult(job, null, recovered);

  assert.match(rendered, /Recovered from the Codex transcript$/m);
  assert.match(rendered, /the turn did finish/);
  assert.doesNotMatch(rendered, /PARTIAL/);
  assert.doesNotMatch(rendered, /may not have finished/);
});

// Each early return in renderStoredJobResult is a separate chance to discard the
// recovered message, and storedJobHasOutput has already decided these count as empty.
test("renderStoredJobResult never lets a blank stored payload discard the recovery", () => {
  const job = { id: "job-1", status: "failed", threadId: THREAD_ID };
  const recovered = { text: "the recovered answer", complete: true, file: "C:/rollout.jsonl" };

  for (const storedJob of [
    { result: { rawOutput: "\n" } },
    { result: { codex: { stdout: "   " } } },
    { rendered: "  \n " },
    { result: { parseError: null }, rendered: "\t" } // the structured-review branch
  ]) {
    const rendered = renderStoredJobResult(job, storedJob, recovered);
    assert.match(rendered, /the recovered answer/, `discarded for ${JSON.stringify(storedJob)}`);
  }
});

test("renderStoredJobResult keeps the empty-payload notice when nothing was recovered", () => {
  const rendered = renderStoredJobResult({ id: "job-1", status: "failed" }, null, null);

  assert.match(rendered, /No captured result payload was stored/);
  assert.doesNotMatch(rendered, /PARTIAL/);
});
