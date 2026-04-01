import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export function installFakeOpencode(binDir, behavior = "task-ok") {
  const statePath = path.join(binDir, "fake-opencode-state.json");
  const scriptPath = path.join(binDir, "opencode");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { runs: [], lastRun: null };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function parseRunArgs(argv) {
  let continueSession = false;
  let sessionId = null;
  let format = null;
  let quiet = false;
  const promptParts = [];

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--continue") {
      continueSession = true;
      continue;
    }
    if (token === "--session") {
      sessionId = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token === "--format") {
      format = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token === "--quiet") {
      quiet = true;
      continue;
    }
    promptParts.push(token);
  }

  return {
    argv,
    continueSession,
    sessionId,
    format,
    quiet,
    prompt: promptParts.join(" ").trim()
  };
}

function buildOutput(run) {
  if (BEHAVIOR === "failing") {
    return {
      status: 1,
      stdout: "",
      stderr: ${JSON.stringify("OpenCode failed unexpectedly.\n")}
    };
  }

  const effectiveSessionId = run.sessionId ?? (run.continueSession ? "sess_continue" : "sess_new");
  const prefix = run.continueSession || run.sessionId ? "Resuming session: " + effectiveSessionId : "Session: " + effectiveSessionId;
  const body = run.continueSession || run.sessionId
    ? ${JSON.stringify("Resumed the prior run.\nFollow-up prompt accepted.\n")}
    : ${JSON.stringify("Handled the requested task.\nTask prompt accepted.\n")};

  return {
    status: 0,
    stdout: prefix + ${JSON.stringify("\n")} + body,
    stderr: ""
  };
}

const argv = process.argv.slice(2);
if (argv[0] === "version" || argv[0] === "--version") {
  console.log("opencode-cli test");
  process.exit(0);
}

if (argv[0] !== "run") {
  console.error("unsupported command");
  process.exit(1);
}

const run = parseRunArgs(argv);
const state = loadState();
state.runs.push(run);
state.lastRun = run;
saveState(state);

const output = buildOutput(run);

if (BEHAVIOR === "slow-task" || BEHAVIOR === "hanging") {
  const delayMs = BEHAVIOR === "hanging" ? 10000 : 400;
  const timer = setTimeout(() => {
    if (output.stdout) {
      process.stdout.write(output.stdout);
    }
    if (output.stderr) {
      process.stderr.write(output.stderr);
    }
    process.exit(output.status);
  }, delayMs);

  process.on("SIGTERM", () => {
    clearTimeout(timer);
    process.exit(0);
  });
  return;
}

if (output.stdout) {
  process.stdout.write(output.stdout);
}
if (output.stderr) {
  process.stderr.write(output.stderr);
}
process.exit(output.status);
`;

  writeExecutable(scriptPath, source);
  return statePath;
}

export function buildEnv(binDir, extraEnv = {}) {
  return {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    ...extraEnv
  };
}
