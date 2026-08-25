import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState
} from "../plugins/codex/scripts/lib/state.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const previousCodexPluginDataDir = process.env.CODEX_COMPANION_PLUGIN_DATA;
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CODEX_COMPANION_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(os.tmpdir()), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    if (previousCodexPluginDataDir == null) {
      delete process.env.CODEX_COMPANION_PLUGIN_DATA;
    } else {
      process.env.CODEX_COMPANION_PLUGIN_DATA = previousCodexPluginDataDir;
    }
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("resolveStateDir falls back to CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousCodexPluginDataDir = process.env.CODEX_COMPANION_PLUGIN_DATA;
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CODEX_COMPANION_PLUGIN_DATA;
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
    if (previousCodexPluginDataDir == null) {
      delete process.env.CODEX_COMPANION_PLUGIN_DATA;
    } else {
      process.env.CODEX_COMPANION_PLUGIN_DATA = previousCodexPluginDataDir;
    }
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("resolveStateDir prefers the Codex plugin data dir over another plugin's host-scoped value", () => {
  const workspace = makeTempDir();
  const codexPluginDataDir = makeTempDir();
  const siblingPluginDataDir = makeTempDir();
  const previousCodexPluginDataDir = process.env.CODEX_COMPANION_PLUGIN_DATA;
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CODEX_COMPANION_PLUGIN_DATA = codexPluginDataDir;
  process.env.CLAUDE_PLUGIN_DATA = siblingPluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(codexPluginDataDir, "state")), true);
    assert.equal(stateDir.startsWith(path.join(siblingPluginDataDir, "state")), false);
  } finally {
    if (previousCodexPluginDataDir == null) {
      delete process.env.CODEX_COMPANION_PLUGIN_DATA;
    } else {
      process.env.CODEX_COMPANION_PLUGIN_DATA = previousCodexPluginDataDir;
    }
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState does not prune another plugin's job when the host-scoped data dir was overwritten", () => {
  const workspace = makeTempDir();
  const codexPluginDataDir = makeTempDir();
  const siblingPluginDataDir = makeTempDir();
  const previousCodexPluginDataDir = process.env.CODEX_COMPANION_PLUGIN_DATA;
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CODEX_COMPANION_PLUGIN_DATA = siblingPluginDataDir;
  process.env.CLAUDE_PLUGIN_DATA = siblingPluginDataDir;

  try {
    const siblingStateFile = resolveStateFile(workspace);
    const siblingJobFile = resolveJobFile(workspace, "sibling-job");
    const siblingLogFile = resolveJobLogFile(workspace, "sibling-job");
    const siblingState = {
      version: 1,
      config: { stopReviewGate: false },
      jobs: [
        {
          id: "sibling-job",
          status: "completed",
          logFile: siblingLogFile,
          createdAt: "2026-08-25T00:00:00.000Z",
          updatedAt: "2026-08-25T00:00:00.000Z"
        }
      ]
    };
    fs.writeFileSync(siblingJobFile, '{"owner":"sibling"}\n', "utf8");
    fs.writeFileSync(siblingLogFile, "sibling output\n", "utf8");
    fs.writeFileSync(siblingStateFile, `${JSON.stringify(siblingState, null, 2)}\n`, "utf8");

    process.env.CODEX_COMPANION_PLUGIN_DATA = codexPluginDataDir;
    saveState(workspace, {
      version: 1,
      config: { stopReviewGate: false },
      jobs: []
    });

    assert.deepEqual(JSON.parse(fs.readFileSync(siblingStateFile, "utf8")), siblingState);
    assert.equal(fs.readFileSync(siblingJobFile, "utf8"), '{"owner":"sibling"}\n');
    assert.equal(fs.readFileSync(siblingLogFile, "utf8"), "sibling output\n");
    assert.equal(fs.existsSync(resolveStateFile(workspace)), true);
  } finally {
    if (previousCodexPluginDataDir == null) {
      delete process.env.CODEX_COMPANION_PLUGIN_DATA;
    } else {
      process.env.CODEX_COMPANION_PLUGIN_DATA = previousCodexPluginDataDir;
    }
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
