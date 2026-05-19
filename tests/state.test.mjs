import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  appendJobEvent,
  readJobEvents,
  resolveJobEventsFile,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState
} from "../plugins/codex/scripts/lib/state.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("resolveJobEventsFile returns a .events.ndjson under the jobs dir", () => {
  const workspace = makeTempDir();
  const eventsFile = resolveJobEventsFile(workspace, "job-evt-1");

  assert.match(path.basename(eventsFile), /^job-evt-1\.events\.ndjson$/);
  assert.equal(path.dirname(eventsFile), path.join(resolveStateDir(workspace), "jobs"));
});

test("appendJobEvent creates the file and readJobEvents returns parsed events", () => {
  const workspace = makeTempDir();
  const jobId = "job-evt-2";

  appendJobEvent(workspace, jobId, { seq: 0, ts: "2026-01-01T00:00:00.000Z", phase: "starting" });
  appendJobEvent(workspace, jobId, { seq: 1, ts: "2026-01-01T00:00:01.000Z", phase: "thinking" });

  const events = readJobEvents(workspace, jobId);
  assert.equal(events.length, 2);
  assert.equal(events[0].seq, 0);
  assert.equal(events[0].phase, "starting");
  assert.equal(events[1].phase, "thinking");
});

test("readJobEvents returns [] when the file does not exist", () => {
  const workspace = makeTempDir();
  const events = readJobEvents(workspace, "never-written");
  assert.deepEqual(events, []);
});

test("readJobEvents afterSeq skips events with seq <= afterSeq", () => {
  const workspace = makeTempDir();
  const jobId = "job-evt-3";
  for (let i = 0; i < 5; i++) {
    appendJobEvent(workspace, jobId, { seq: i, ts: `2026-01-01T00:00:0${i}.000Z`, phase: "p" });
  }
  const events = readJobEvents(workspace, jobId, { afterSeq: 2 });
  assert.deepEqual(
    events.map((event) => event.seq),
    [3, 4]
  );
});

test("readJobEvents since filters by ISO timestamp string", () => {
  const workspace = makeTempDir();
  const jobId = "job-evt-4";
  appendJobEvent(workspace, jobId, { seq: 0, ts: "2026-01-01T00:00:00.000Z", phase: "p" });
  appendJobEvent(workspace, jobId, { seq: 1, ts: "2026-01-01T00:00:05.000Z", phase: "p" });
  appendJobEvent(workspace, jobId, { seq: 2, ts: "2026-01-01T00:00:10.000Z", phase: "p" });

  const events = readJobEvents(workspace, jobId, { since: "2026-01-01T00:00:03.000Z" });
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2]
  );
});

test("readJobEvents afterSeq takes precedence over since", () => {
  const workspace = makeTempDir();
  const jobId = "job-evt-5";
  appendJobEvent(workspace, jobId, { seq: 0, ts: "2026-01-01T00:00:00.000Z" });
  appendJobEvent(workspace, jobId, { seq: 1, ts: "2026-01-01T00:00:05.000Z" });
  appendJobEvent(workspace, jobId, { seq: 2, ts: "2026-01-01T00:00:10.000Z" });

  // since alone would return [seq=1, seq=2]; afterSeq=1 narrows to [seq=2].
  const events = readJobEvents(workspace, jobId, {
    afterSeq: 1,
    since: "2026-01-01T00:00:00.000Z"
  });
  assert.deepEqual(
    events.map((event) => event.seq),
    [2]
  );
});

test("readJobEvents limit caps the returned array", () => {
  const workspace = makeTempDir();
  const jobId = "job-evt-6";
  for (let i = 0; i < 10; i++) {
    appendJobEvent(workspace, jobId, { seq: i, ts: "2026-01-01T00:00:00.000Z" });
  }
  const events = readJobEvents(workspace, jobId, { limit: 3 });
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((event) => event.seq),
    [0, 1, 2]
  );
});

test("readJobEvents tolerates a partial last line (mid-write)", () => {
  const workspace = makeTempDir();
  const jobId = "job-evt-7";
  appendJobEvent(workspace, jobId, { seq: 0, ts: "2026-01-01T00:00:00.000Z", phase: "p" });

  // Simulate a writer in the middle of emitting a second event:
  // the JSON has been written but the trailing newline has not.
  const eventsFile = resolveJobEventsFile(workspace, jobId);
  fs.appendFileSync(eventsFile, '{"seq":1,"ts":"2026-01-01T00:00:01.000Z","phase":"thinking"', "utf8");

  const events = readJobEvents(workspace, jobId);
  assert.equal(events.length, 1, "partial last line must be skipped, not throw");
  assert.equal(events[0].seq, 0);
});

test("appendJobEvent truncates raw field when single line would exceed 4KB", () => {
  const workspace = makeTempDir();
  const jobId = "job-evt-8";
  const bigRaw = { huge: "x".repeat(5000), other: "field" };

  appendJobEvent(workspace, jobId, {
    seq: 0,
    ts: "2026-01-01T00:00:00.000Z",
    phase: "tool:bash",
    raw: bigRaw
  });

  const events = readJobEvents(workspace, jobId);
  assert.equal(events.length, 1);
  assert.equal(events[0].seq, 0);
  assert.equal(events[0].phase, "tool:bash");
  assert.equal(events[0].raw.truncated, true);
  assert.match(events[0].raw.summary, /huge|other/);

  const eventsFile = resolveJobEventsFile(workspace, jobId);
  const bytes = fs.statSync(eventsFile).size;
  assert.ok(bytes <= 4096, `line should fit in 4KB, got ${bytes} bytes`);
});

test("appendJobEvent elides event entirely when even truncated raw is too big", () => {
  const workspace = makeTempDir();
  const jobId = "job-evt-9";
  const massiveMessage = "y".repeat(5000);

  // message itself oversize, raw not the culprit
  appendJobEvent(workspace, jobId, {
    seq: 0,
    ts: "2026-01-01T00:00:00.000Z",
    method: "turn/started",
    phase: "tool:bash",
    message: massiveMessage,
    raw: null
  });

  const events = readJobEvents(workspace, jobId);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "oversize-event-elided");
  assert.equal(events[0].seq, 0);
  assert.equal(events[0].method, "turn/started");
  assert.equal(events[0].phase, "tool:bash");
});
