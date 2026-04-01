#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { getOpenCodeAvailability, getOpenCodeAuthStatus, runOpenCodeTask } from "./lib/opencode.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import {
  generateJobId,
  listJobs,
  resolveJobFile,
  resolveJobLogFile,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderCancelReport,
  renderJobResult,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SESSION_ID_ENV = "OPENCODE_COMPANION_SESSION_ID";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function normalizeArgv(argv) {
  if (argv.length === 1 && argv[0]?.trim()) {
    return splitRawArgumentString(argv[0]);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }
}

function appendLogLine(logFile, message) {
  if (!logFile || !message) return;
  fs.appendFileSync(logFile, `[${nowIso()}] ${String(message).trim()}\n`, "utf8");
}

function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const openCodeStatus = getOpenCodeAvailability(cwd);
  const asJson = options.json === true;

  const nextSteps = [];
  if (!openCodeStatus.available) {
    nextSteps.push("Install OpenCode: `curl -fsSL https://opencode.ai/install | bash` or `npm i -g opencode-ai@latest`.");
  }

  const report = {
    ready: nodeStatus.available && openCodeStatus.available,
    node: nodeStatus,
    opencode: openCodeStatus,
    nextSteps
  };

  outputResult(asJson ? report : renderSetupReport(report), asJson);
}

// ---------------------------------------------------------------------------
// task (the core — equivalent to codex rescue)
// ---------------------------------------------------------------------------

async function handleTask(argv) {
  // Accept --write for compatibility with rescue forwarders, but OpenCode
  // controls permissions through its own configuration rather than this CLI.
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "session"],
    booleanOptions: ["continue", "write", "background", "json"]
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const prompt = positionals.join(" ").trim();
  const continueSession = options.continue === true;
  const sessionId = typeof options.session === "string" ? options.session : null;
  const background = options.background === true;
  const asJson = options.json === true;

  // Validate
  const authStatus = getOpenCodeAuthStatus(cwd);
  if (!authStatus.available) {
    throw new Error("OpenCode is not installed. Run `/opencode:setup` for instructions.");
  }

  if (!prompt && !continueSession && !sessionId) {
    throw new Error("Provide a prompt or use --continue to resume the previous session.");
  }

  const jobId = generateJobId("task");
  const title = continueSession ? "OpenCode Resume" : "OpenCode Task";
  const summary = shorten(prompt || "Continue previous session");

  // Create job record
  const job = {
    id: jobId,
    kind: "task",
    jobClass: "task",
    title,
    summary,
    status: "running",
    phase: "starting",
    workspaceRoot,
    createdAt: nowIso(),
    startedAt: nowIso(),
    pid: process.pid,
    ...(process.env[SESSION_ID_ENV] ? { sessionId: process.env[SESSION_ID_ENV] } : {})
  };

  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  appendLogLine(logFile, `Starting ${title}.`);

  if (background) {
    // Spawn detached worker
    const scriptPath = path.join(ROOT_DIR, "scripts", "opencode-companion.mjs");
    const workerArgs = ["task-worker", "--cwd", cwd, "--job-id", jobId];
    const child = spawn(process.execPath, [scriptPath, ...workerArgs], {
      cwd,
      env: process.env,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();

    const queuedJob = { ...job, status: "queued", phase: "queued", pid: child.pid ?? null, logFile, request: { cwd, prompt, continueSession, sessionId } };
    writeJobFile(workspaceRoot, jobId, queuedJob);
    upsertJob(workspaceRoot, queuedJob);

    const payload = { jobId, status: "queued", title, summary, logFile };
    outputResult(
      asJson ? payload : `${title} started in the background as ${jobId}. Check /opencode:status ${jobId} for progress.\n`,
      asJson
    );
    return;
  }

  // Foreground execution
  writeJobFile(workspaceRoot, jobId, { ...job, logFile });
  upsertJob(workspaceRoot, job);

  const onProgress = (msg) => {
    const text = typeof msg === "string" ? msg : msg?.message ?? "";
    if (text) {
      process.stderr.write(`[opencode] ${text}\n`);
      appendLogLine(logFile, text);
    }
  };

  try {
    const result = await runOpenCodeTask(cwd, {
      prompt,
      continueSession,
      sessionId,
      onProgress
    });

    const completionStatus = result.status === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    const rendered = renderTaskResult(result);

    writeJobFile(workspaceRoot, jobId, {
      ...job,
      status: completionStatus,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      pid: null,
      logFile,
      sessionId: job.sessionId ?? null,
      opencodeSessionId: result.sessionId ?? null,
      result: { status: result.status, stdout: result.stdout, stderr: result.stderr },
      rendered
    });
    upsertJob(workspaceRoot, {
      id: jobId,
      status: completionStatus,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      pid: null,
      sessionId: job.sessionId ?? null,
      opencodeSessionId: result.sessionId ?? null,
      summary: shorten(result.stdout || summary)
    });

    appendLogLine(logFile, `Task ${completionStatus}.`);
    outputResult(asJson ? { jobId, status: completionStatus, ...result } : rendered, asJson);

    if (result.status !== 0) {
      process.exitCode = result.status;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();
    writeJobFile(workspaceRoot, jobId, {
      ...job,
      status: "failed",
      phase: "failed",
      completedAt,
      pid: null,
      logFile,
      errorMessage
    });
    upsertJob(workspaceRoot, {
      id: jobId,
      status: "failed",
      phase: "failed",
      completedAt,
      pid: null,
      errorMessage
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// task-worker (detached background execution)
// ---------------------------------------------------------------------------

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });
  const jobId = options["job-id"];
  if (!jobId) throw new Error("Missing required --job-id for task-worker.");

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) throw new Error(`No stored job found for ${jobId}.`);

  const storedJob = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  const request = storedJob.request;
  if (!request) throw new Error(`Stored job ${jobId} is missing its request payload.`);

  const logFile = storedJob.logFile ?? resolveJobLogFile(workspaceRoot, jobId);

  // Mark running
  const runningJob = { ...storedJob, status: "running", phase: "running", startedAt: nowIso(), pid: process.pid };
  writeJobFile(workspaceRoot, jobId, runningJob);
  upsertJob(workspaceRoot, { id: jobId, status: "running", phase: "running", pid: process.pid });

  const onProgress = (msg) => {
    const text = typeof msg === "string" ? msg : msg?.message ?? "";
    appendLogLine(logFile, text);
  };

  try {
    const result = await runOpenCodeTask(request.cwd ?? cwd, {
      prompt: request.prompt,
      continueSession: request.continueSession,
      sessionId: request.sessionId,
      onProgress
    });

    const completionStatus = result.status === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    const rendered = renderTaskResult(result);

    writeJobFile(workspaceRoot, jobId, {
      ...runningJob,
      status: completionStatus,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      pid: null,
      sessionId: runningJob.sessionId ?? null,
      opencodeSessionId: result.sessionId ?? null,
      result: { status: result.status, stdout: result.stdout, stderr: result.stderr },
      rendered
    });
    upsertJob(workspaceRoot, {
      id: jobId,
      status: completionStatus,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      pid: null,
      sessionId: runningJob.sessionId ?? null,
      opencodeSessionId: result.sessionId ?? null,
      summary: shorten(result.stdout || runningJob.summary || "")
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();
    writeJobFile(workspaceRoot, jobId, {
      ...runningJob,
      status: "failed",
      phase: "failed",
      completedAt,
      pid: null,
      errorMessage
    });
    upsertJob(workspaceRoot, { id: jobId, status: "failed", phase: "failed", completedAt, pid: null, errorMessage });
  }
}

// ---------------------------------------------------------------------------
// task-resume-candidate
// ---------------------------------------------------------------------------

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = process.env[SESSION_ID_ENV] ?? null;
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));

  const candidate = jobs.find(
    (job) =>
      job.jobClass === "task" &&
      job.status !== "queued" &&
      job.status !== "running" &&
      (!sessionId || job.sessionId === sessionId)
  ) ?? null;

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate: candidate ? {
      id: candidate.id,
      status: candidate.status,
      title: candidate.title ?? null,
      summary: candidate.summary ?? null,
      sessionId: candidate.sessionId ?? null,
      completedAt: candidate.completedAt ?? null
    } : null
  };

  const asJson = options.json === true;
  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputResult(asJson ? payload : rendered, asJson);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const workspaceRoot = resolveCommandWorkspace(options);
  const asJson = options.json === true;

  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const reference = positionals[0] ?? "";

  if (reference) {
    const job = jobs.find((j) => j.id === reference || j.id.startsWith(reference));
    if (!job) throw new Error(`No job found for "${reference}".`);
    outputResult(asJson ? job : `${job.id} | ${job.status} | ${job.title ?? "task"} | ${job.summary ?? ""}\n`, asJson);
    return;
  }

  const running = jobs.filter((j) => j.status === "queued" || j.status === "running");
  const recent = jobs.filter((j) => j.status !== "queued" && j.status !== "running").slice(0, 8);
  const report = { running, recent };
  outputResult(asJson ? report : renderStatusReport(report), asJson);
}

// ---------------------------------------------------------------------------
// result
// ---------------------------------------------------------------------------

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const workspaceRoot = resolveCommandWorkspace(options);
  const asJson = options.json === true;

  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const reference = positionals[0] ?? "";

  const finished = jobs.filter((j) => j.status === "completed" || j.status === "failed" || j.status === "cancelled");
  const job = reference
    ? finished.find((j) => j.id === reference || j.id.startsWith(reference))
    : finished[0];

  if (!job) throw new Error(reference ? `No finished job found for "${reference}".` : "No finished jobs yet.");

  const jobFile = resolveJobFile(workspaceRoot, job.id);
  const storedJob = fs.existsSync(jobFile) ? JSON.parse(fs.readFileSync(jobFile, "utf8")) : null;

  outputResult(asJson ? { job, storedJob } : renderJobResult(job, storedJob), asJson);
}

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const workspaceRoot = resolveCommandWorkspace(options);
  const asJson = options.json === true;

  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const reference = positionals[0] ?? "";
  const activeJobs = jobs.filter((j) => j.status === "queued" || j.status === "running");

  let job;
  if (reference) {
    job = activeJobs.find((j) => j.id === reference || j.id.startsWith(reference));
    if (!job) throw new Error(`No active job found for "${reference}".`);
  } else if (activeJobs.length === 1) {
    job = activeJobs[0];
  } else if (activeJobs.length > 1) {
    throw new Error("Multiple jobs are active. Pass a job id to cancel.");
  } else {
    throw new Error("No active jobs to cancel.");
  }

  terminateProcessTree(job.pid ?? Number.NaN);

  const logFile = job.logFile ?? resolveJobLogFile(workspaceRoot, job.id);
  appendLogLine(logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const cancelledJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  const jobFile = resolveJobFile(workspaceRoot, job.id);
  const existing = fs.existsSync(jobFile) ? JSON.parse(fs.readFileSync(jobFile, "utf8")) : {};
  writeJobFile(workspaceRoot, job.id, { ...existing, ...cancelledJob });
  upsertJob(workspaceRoot, { id: job.id, status: "cancelled", phase: "cancelled", pid: null, errorMessage: "Cancelled by user.", completedAt });

  outputResult(asJson ? { jobId: job.id, status: "cancelled" } : renderCancelReport(cancelledJob), asJson);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function printUsage() {
  console.log([
    "Usage:",
    "  node opencode-companion.mjs setup [--cwd <path>] [--json]",
    "  node opencode-companion.mjs task [--cwd <path>] [--background] [--continue] [--session <id>] [--json] [prompt]",
    "  node opencode-companion.mjs status [--cwd <path>] [job-id] [--json]",
    "  node opencode-companion.mjs result [--cwd <path>] [job-id] [--json]",
    "  node opencode-companion.mjs cancel [--cwd <path>] [job-id] [--json]",
    "  node opencode-companion.mjs task-resume-candidate [--cwd <path>] [--json]"
  ].join("\n"));
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      handleSetup(argv);
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "status":
      handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "cancel":
      handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
