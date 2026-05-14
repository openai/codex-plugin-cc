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

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;

  try {
    delete process.env.CLAUDE_PLUGIN_DATA;
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(os.tmpdir()), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
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

test("saveState retains all recent review jobs beyond the global cap", () => {
  const workspace = makeTempDir();
  const nowMs = Date.now();
  const taskJobs = Array.from({ length: 40 }, (_, index) => {
    const updatedAt = new Date(nowMs - index * 1_000).toISOString();
    return {
      id: `task-${index}`,
      status: "completed",
      jobClass: "task",
      updatedAt,
      createdAt: updatedAt
    };
  });
  const reviewJobs = Array.from({ length: 30 }, (_, index) => {
    const updatedAt = new Date(nowMs - (40 + index) * 1_000).toISOString();
    return {
      id: `review-${index}`,
      status: "completed",
      ...(index % 2 === 0 ? { jobClass: "review" } : { kind: "adversarial-review" }),
      invoker: "claude-subagent",
      updatedAt,
      createdAt: updatedAt
    };
  });

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [...taskJobs, ...reviewJobs]
  });

  const loadedJobIds = new Set(loadState(workspace).jobs.map((job) => job.id));

  for (const job of reviewJobs) {
    assert.equal(loadedJobIds.has(job.id), true, `expected ${job.id} to be retained`);
  }
});

test("saveState caps recent review jobs before applying the global cap to older jobs", () => {
  const workspace = makeTempDir();
  const nowMs = Date.now();
  const maxRecentReviewJobs = 500;
  const maxJobs = 50;
  const reviewJobs = Array.from({ length: 600 }, (_, index) => {
    const createdAt = new Date(nowMs - index * 1_000).toISOString();
    return {
      id: `review-${index}`,
      status: "completed",
      jobClass: "review",
      invoker: "claude-subagent",
      createdAt,
      updatedAt: createdAt
    };
  });
  const olderNonReviewJobs = Array.from({ length: 60 }, (_, index) => {
    const updatedAt = new Date(nowMs - 66 * 60_000 - index * 1_000).toISOString();
    return {
      id: `task-${index}`,
      status: "completed",
      jobClass: "task",
      createdAt: updatedAt,
      updatedAt
    };
  });

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [...olderNonReviewJobs, ...reviewJobs]
  });

  const loadedJobs = loadState(workspace).jobs;
  const loadedReviewJobs = loadedJobs.filter((job) => job.jobClass === "review");
  const loadedTaskJobs = loadedJobs.filter((job) => job.jobClass === "task");
  const retainedReviewIdsByCreatedAt = [...loadedReviewJobs]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .map((job) => job.id);

  assert.equal(loadedJobs.length, maxRecentReviewJobs + maxJobs);
  assert.equal(loadedReviewJobs.length, maxRecentReviewJobs);
  assert.equal(loadedTaskJobs.length, maxJobs);
  assert.deepEqual(
    retainedReviewIdsByCreatedAt,
    Array.from({ length: maxRecentReviewJobs }, (_, index) => `review-${index}`)
  );
});

test("saveState still caps old review jobs", () => {
  const workspace = makeTempDir();
  const nowMs = Date.now();
  const jobs = Array.from({ length: 51 }, (_, index) => ({
    id: `old-review-${index}`,
    status: "completed",
    jobClass: "review",
    invoker: "claude-subagent",
    createdAt: new Date(nowMs - 66 * 60_000).toISOString(),
    updatedAt: new Date(nowMs - (51 - index) * 1_000).toISOString()
  }));

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const loadedJobs = loadState(workspace).jobs;
  const loadedJobIds = new Set(loadedJobs.map((job) => job.id));

  assert.equal(loadedJobs.length, 50);
  assert.equal(loadedJobIds.has("old-review-0"), false);
});
