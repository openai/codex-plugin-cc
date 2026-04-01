import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeOpencode } from "./fake-opencode-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveStateDir, saveState } from "../plugins/opencode/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "opencode");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "opencode-companion.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function loadStateJson(repo) {
  return JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
}

test("opencode setup reports ready when fake opencode is installed", () => {
  const binDir = makeTempDir();
  installFakeOpencode(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.opencode.available, true);
  assert.match(payload.opencode.detail, /opencode-cli test/);
});

test("opencode task keeps the first prompt token after --continue", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = installFakeOpencode(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "task", "--continue", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Resumed the prior run/);
  const fixtureState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fixtureState.lastRun.continueSession, true);
  assert.equal(fixtureState.lastRun.prompt, "follow up");
});

test("opencode background tasks persist a terminal phase after completion", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir, "slow-task");
  initGitRepo(repo);

  const start = run("node", [SCRIPT, "task", "--background", "--json", "investigate regression"], {
    cwd: repo,
    env: buildEnv(binDir, { OPENCODE_COMPANION_SESSION_ID: "sess-current" })
  });

  assert.equal(start.status, 0, start.stderr);
  const payload = JSON.parse(start.stdout);

  const job = await waitFor(() => {
    const state = loadStateJson(repo);
    return state.jobs.find((entry) => entry.id === payload.jobId && entry.status === "completed") ?? null;
  });

  assert.equal(job.phase, "done");
  assert.equal(job.sessionId, "sess-current");

  const result = run("node", [SCRIPT, "result", payload.jobId], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("opencode cancel marks a hanging background job as cancelled", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir, "hanging");
  initGitRepo(repo);

  const start = run("node", [SCRIPT, "task", "--background", "--json", "long running task"], {
    cwd: repo,
    env: buildEnv(binDir, { OPENCODE_COMPANION_SESSION_ID: "sess-cancel" })
  });

  assert.equal(start.status, 0, start.stderr);
  const payload = JSON.parse(start.stdout);

  await waitFor(() => {
    const state = loadStateJson(repo);
    return state.jobs.find((entry) => entry.id === payload.jobId && (entry.status === "queued" || entry.status === "running")) ?? null;
  });

  const cancel = run("node", [SCRIPT, "cancel", payload.jobId, "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(cancel.status, 0, cancel.stderr);
  const cancelPayload = JSON.parse(cancel.stdout);
  assert.equal(cancelPayload.status, "cancelled");

  const cancelledJob = await waitFor(() => {
    const state = loadStateJson(repo);
    return state.jobs.find((entry) => entry.id === payload.jobId && entry.status === "cancelled") ?? null;
  });

  assert.equal(cancelledJob.phase, "cancelled");
});

test("opencode task-resume-candidate returns the latest task from the current session", () => {
  const repo = makeTempDir();
  saveState(repo, {
    version: 1,
    config: {},
    jobs: [
      {
        id: "task-current",
        status: "completed",
        phase: "done",
        title: "OpenCode Task",
        jobClass: "task",
        sessionId: "sess-current",
        summary: "Investigate the failing test",
        completedAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z"
      },
      {
        id: "task-other",
        status: "completed",
        phase: "done",
        title: "OpenCode Task",
        jobClass: "task",
        sessionId: "sess-other",
        summary: "Older task",
        completedAt: "2026-03-31T00:00:00.000Z",
        updatedAt: "2026-03-31T00:00:00.000Z"
      }
    ]
  });

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: repo,
    env: {
      ...process.env,
      OPENCODE_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.candidate.id, "task-current");
  assert.equal(payload.candidate.sessionId, "sess-current");
});

test("opencode session lifecycle hook exports env vars and clears session jobs", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  fs.writeFileSync(envFile, "", "utf8");

  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const sessionStart = run("node", [SESSION_HOOK, "SessionStart"], {
      cwd: repo,
      env: {
        ...process.env,
        CLAUDE_ENV_FILE: envFile,
        CLAUDE_PLUGIN_DATA: pluginDataDir
      },
      input: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "sess-current",
        cwd: repo
      })
    });

    assert.equal(sessionStart.status, 0, sessionStart.stderr);
    assert.equal(
      fs.readFileSync(envFile, "utf8"),
      `export OPENCODE_COMPANION_SESSION_ID='sess-current'\nexport CLAUDE_PLUGIN_DATA='${pluginDataDir}'\n`
    );

    saveState(repo, {
      version: 1,
      config: {},
      jobs: [
        {
          id: "task-current",
          status: "completed",
          phase: "done",
          sessionId: "sess-current",
          updatedAt: "2026-04-01T00:00:00.000Z"
        },
        {
          id: "task-other",
          status: "completed",
          phase: "done",
          sessionId: "sess-other",
          updatedAt: "2026-03-31T00:00:00.000Z"
        }
      ]
    });

    const sessionEnd = run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginDataDir,
        OPENCODE_COMPANION_SESSION_ID: "sess-current"
      },
      input: JSON.stringify({
        hook_event_name: "SessionEnd",
        session_id: "sess-current",
        cwd: repo
      })
    });

    assert.equal(sessionEnd.status, 0, sessionEnd.stderr);
    const state = loadStateJson(repo);
    assert.deepEqual(state.jobs.map((job) => job.id), ["task-other"]);
  } finally {
    if (previousPluginDataDir === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});
