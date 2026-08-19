import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  loadState,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState
} from "../plugins/codex/scripts/lib/state.mjs";
import { readStoredJob } from "../plugins/codex/scripts/lib/job-control.mjs";

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

// The reverse (state written *with* CLAUDE_PLUGIN_DATA set, later read with
// it unset) isn't fixable this way: an unset env var carries no trace of
// what value it previously held, so there's nothing to check beyond the
// always-known tmpdir fallback. This direction is the one with concrete
// real-world evidence in the issue (a broker registered under the tmpdir
// fallback, later orphaned by a lookup that ran with CLAUDE_PLUGIN_DATA set).
test("loadState finds state written without CLAUDE_PLUGIN_DATA when the current invocation has it set", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;

  try {
    delete process.env.CLAUDE_PLUGIN_DATA;
    saveState(workspace, { config: { stopReviewGate: true }, jobs: [] });

    process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
    const state = loadState(workspace);

    assert.equal(state.config.stopReviewGate, true);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

// Caught in review: jobs are a growing collection, not a single pointer like
// the broker session -- a job started while CLAUDE_PLUGIN_DATA was set and a
// different job started while it was unset are both real and non-
// conflicting, so loadState() must merge every candidate's jobs rather than
// returning only the first state.json found (which would silently hide
// whichever root wasn't picked, for every status/result/cancel lookup, any
// time both roots happen to have a state.json -- a reachable legacy state
// after invocations alternated).
function writeStateFileDirectly(stateDir, state) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

test("loadState merges jobs from every candidate root instead of only the first found", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;

  try {
    // Written directly (not via saveState()) so this test exercises only
    // loadState()'s read-side merge, independent of saveState()'s own
    // write/deletion-propagation behavior (covered separately below).
    delete process.env.CLAUDE_PLUGIN_DATA;
    writeStateFileDirectly(resolveStateDir(workspace), {
      config: {},
      jobs: [{ id: "job-fallback", status: "running", updatedAt: "2026-08-19T00:00:00.000Z" }]
    });

    process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
    writeStateFileDirectly(resolveStateDir(workspace), {
      config: {},
      jobs: [{ id: "job-plugin-data", status: "running", updatedAt: "2026-08-19T00:01:00.000Z" }]
    });

    const state = loadState(workspace);
    const jobIds = state.jobs.map((job) => job.id).sort();

    assert.deepEqual(jobIds, ["job-fallback", "job-plugin-data"]);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

// Caught in review: merging reads across roots (the previous test) isn't
// enough on its own -- saveState() only ever wrote the new job list to the
// current primary root, so a job that originated in a *different* root and
// gets filtered out (e.g. cleanupSessionJobs() during SessionEnd, which
// loads the merged view, drops jobs for the ending session, and saves the
// remainder) never actually disappears: the other root's own state.json
// still has its own untouched copy, and the next loadState() merges it
// right back in. A "removed" job could keep reporting as running forever.
test("saveState persists a job removal across every candidate root, not just the current primary", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;

  try {
    // Setup writes both roots directly (not via saveState()), exactly like
    // the previous test -- a real caller always derives saveState()'s job
    // list from a prior loadState() (see updateState()/cleanupSessionJobs()
    // themselves), so seeding two roots via two independent, non-full-list
    // saveState() calls wouldn't reflect any real call pattern and would
    // trip the very deletion-propagation behavior under test here.
    delete process.env.CLAUDE_PLUGIN_DATA;
    writeStateFileDirectly(resolveStateDir(workspace), {
      config: {},
      jobs: [
        { id: "job-fallback-keep", status: "running", updatedAt: "2026-08-19T00:00:00.000Z" },
        { id: "job-fallback-remove", status: "running", updatedAt: "2026-08-19T00:00:00.000Z" }
      ]
    });

    process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
    writeStateFileDirectly(resolveStateDir(workspace), {
      config: {},
      jobs: [{ id: "job-plugin-data", status: "running", updatedAt: "2026-08-19T00:01:00.000Z" }]
    });

    // Mirrors cleanupSessionJobs(): load the merged view, drop one job that
    // originated entirely in the fallback root, save the remainder -- still
    // with CLAUDE_PLUGIN_DATA set, the same as a real SessionEnd hook.
    const merged = loadState(workspace);
    saveState(workspace, {
      ...merged,
      jobs: merged.jobs.filter((job) => job.id !== "job-fallback-remove")
    });

    const jobIdsAfterRemoval = loadState(workspace)
      .jobs.map((job) => job.id)
      .sort();

    assert.deepEqual(jobIdsAfterRemoval, ["job-fallback-keep", "job-plugin-data"]);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("readStoredJob finds a job's detail file written without CLAUDE_PLUGIN_DATA when the current invocation has it set", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;

  try {
    delete process.env.CLAUDE_PLUGIN_DATA;
    const jobFile = resolveJobFile(workspace, "job-1");
    fs.writeFileSync(jobFile, JSON.stringify({ id: "job-1", status: "completed" }), "utf8");

    process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
    const job = readStoredJob(workspace, "job-1");

    assert.deepEqual(job, { id: "job-1", status: "completed" });
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
