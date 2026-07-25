import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSingleJobSnapshot,
  readStoredJob,
  resolveResultJob
} from "../plugins/codex/scripts/lib/job-control.mjs";
import { resolveStateFile, saveState, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { initGitRepo, makeTempDir } from "./helpers.mjs";

function completedJob(id, workspaceRoot) {
  return {
    id,
    kind: "task",
    jobClass: "task",
    title: "Codex Task",
    workspaceRoot,
    status: "completed",
    createdAt: "2026-07-25T10:00:00.000Z",
    updatedAt: "2026-07-25T10:01:00.000Z"
  };
}

function saveCompletedJob(workspaceRoot, job) {
  saveState(workspaceRoot, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [job]
  });
  writeJobFile(workspaceRoot, job.id, {
    ...job,
    result: { rawOutput: `result for ${job.id}` }
  });
}

test("explicit status and result lookups find a job after cwd moves to another repository", () => {
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  const pluginData = makeTempDir();
  const originalWorkspace = makeTempDir();
  const currentWorkspace = makeTempDir();
  process.env.CLAUDE_PLUGIN_DATA = pluginData;

  try {
    initGitRepo(originalWorkspace);
    initGitRepo(currentWorkspace);
    const job = completedJob("task-cross-workspace-1234", originalWorkspace);
    saveCompletedJob(originalWorkspace, job);

    const status = buildSingleJobSnapshot(currentWorkspace, job.id);
    assert.equal(status.workspaceRoot, originalWorkspace);
    assert.equal(status.job.id, job.id);

    const result = resolveResultJob(currentWorkspace, "task-cross-workspace");
    assert.equal(result.workspaceRoot, originalWorkspace);
    assert.equal(result.job.id, job.id);
    assert.equal(readStoredJob(result.workspaceRoot, result.job.id).result.rawOutput, `result for ${job.id}`);
  } finally {
    if (previousPluginData == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
  }
});

test("cross-workspace lookup rejects ambiguous prefixes", () => {
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  const pluginData = makeTempDir();
  const firstWorkspace = makeTempDir();
  const secondWorkspace = makeTempDir();
  const currentWorkspace = makeTempDir();
  process.env.CLAUDE_PLUGIN_DATA = pluginData;

  try {
    for (const workspace of [firstWorkspace, secondWorkspace, currentWorkspace]) {
      initGitRepo(workspace);
    }
    saveCompletedJob(firstWorkspace, completedJob("task-shared-prefix-one", firstWorkspace));
    saveCompletedJob(secondWorkspace, completedJob("task-shared-prefix-two", secondWorkspace));

    assert.throws(
      () => buildSingleJobSnapshot(currentWorkspace, "task-shared-prefix"),
      /Job reference "task-shared-prefix" is ambiguous/
    );

    const exactJob = completedJob("task-shared-prefix", currentWorkspace);
    saveCompletedJob(currentWorkspace, exactJob);
    const exact = buildSingleJobSnapshot(currentWorkspace, exactJob.id);
    assert.equal(path.normalize(exact.workspaceRoot), path.normalize(currentWorkspace));
    assert.equal(exact.job.id, exactJob.id);
  } finally {
    if (previousPluginData == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
  }
});

test("cross-workspace lookup ignores records stored under the wrong workspace key", () => {
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  const pluginData = makeTempDir();
  const claimedWorkspace = makeTempDir();
  const storageWorkspace = makeTempDir();
  const currentWorkspace = makeTempDir();
  process.env.CLAUDE_PLUGIN_DATA = pluginData;

  try {
    for (const workspace of [claimedWorkspace, storageWorkspace, currentWorkspace]) {
      initGitRepo(workspace);
    }
    const forgedJob = completedJob("task-mismatched-workspace", claimedWorkspace);
    const stateFile = resolveStateFile(storageWorkspace);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(
      stateFile,
      `${JSON.stringify(
        {
          version: 1,
          config: { stopReviewGate: false },
          jobs: [forgedJob]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    assert.throws(
      () => buildSingleJobSnapshot(currentWorkspace, forgedJob.id),
      /No job found for "task-mismatched-workspace"/
    );
  } finally {
    if (previousPluginData == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
  }
});
