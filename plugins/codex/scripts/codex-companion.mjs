#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  compactShiftHistory,
  formatCompactForPrompt,
  getActiveShiftSessionId,
  initShiftSession,
  listShiftSessions,
  mergeAllShiftSessions,
  readShiftHistory,
  readShiftCompact,
  setShiftSessionCodexJobId
} from "./lib/shift-history.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  if (request.resumeThreadId) {
    // Explicit thread supplied (e.g. monitor resume reusing same Codex thread)
    resumeThreadId = request.resumeThreadId;
  } else if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    sandbox: request.write ? "workspace-write" : "read-only",
    onProgress: request.onProgress,
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId, resumeThreadId = null }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId,
    resumeThreadId
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function handleMonitor(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "resume-session"],
    booleanOptions: ["json", "resume", "list-sessions"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);

  // --list-sessions: just print existing sessions and exit, don't start anything
  if (options["list-sessions"]) {
    const sessions = listShiftSessions(workspaceRoot);
    if (sessions.length === 0) {
      const rendered = "No shift sessions found for this project.\n";
      outputCommandResult({ sessions: [] }, rendered, options.json);
      return;
    }
    const lines = sessions.map((s) =>
      `${s.active ? "[active] " : "         "}${s.id}  ${s.startedAt.slice(0, 10)}  ${s.turnCount} turn${s.turnCount !== 1 ? "s" : ""}${s.resumed ? "  (resumed)" : ""}`
    );
    const rendered = [
      "Shift sessions for this project:",
      ...lines,
      "",
      `To resume a session:  /codex:monitor --resume-session <id>`,
      `To resume the active: /codex:monitor --resume`,
      `To start fresh:       /codex:monitor`,
      ""
    ].join("\n");
    outputCommandResult({ sessions }, rendered, options.json);
    return;
  }

  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);

  ensureCodexAvailable(cwd);

  // Resolve which session to use before initializing
  let resolvedResumeSessionId = null;

  if (options.resume || options["resume-session"]) {
    const existing = listShiftSessions(workspaceRoot);
    const rawPick = options["resume-session"] ?? null;

    if (rawPick !== null) {
      const asNumber = Number(rawPick);
      if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= existing.length) {
        // User passed a list number like --resume-session 2
        resolvedResumeSessionId = existing[asNumber - 1].id;
      } else {
        // User passed a full session ID
        resolvedResumeSessionId = rawPick;
      }
    } else if (existing.length === 1) {
      // --resume with exactly one session → auto-pick it
      resolvedResumeSessionId = existing[0].id;
    } else if (existing.length > 1) {
      // --resume with multiple sessions → print numbered list with summaries, stop
      const lines = existing.flatMap((s, i) => {
        const badge = s.active ? " [active]" : "";
        const meta = `${s.startedAt.slice(0, 10)}  ${s.turnCount} turn${s.turnCount !== 1 ? "s" : ""}`;
        const header = `  ${i + 1}.${badge} ${meta}`;
        const summary = s.lastSummary ? `       └─ ${s.lastSummary}` : null;
        return summary ? [header, summary] : [header];
      });
      const rendered = [
        "Multiple shift sessions found. Pick one:",
        ...lines,
        "",
        "Re-run with:  /codex:monitor --resume-session <number>",
        ""
      ].join("\n");
      outputCommandResult({ sessions: existing, needsPick: true }, rendered, options.json);
      return;
    }
    // existing.length === 0 with --resume → fall through to fresh start
  }

  const isResumed = Boolean(resolvedResumeSessionId);
  const shiftSessionId = initShiftSession(workspaceRoot, {
    resume: isResumed,
    sessionId: resolvedResumeSessionId
  });

  // When resuming, reuse the same Codex thread so `codex resume` doesn't
  // accumulate a new entry every time the user runs /codex:monitor.
  let prevCodexThreadId = null;
  if (isResumed) {
    const sessions = listShiftSessions(workspaceRoot);
    const chosenMeta = sessions.find((s) => s.id === shiftSessionId);
    if (chosenMeta?.codexJobId) {
      const prevStoredJob = readStoredJob(workspaceRoot, chosenMeta.codexJobId);
      prevCodexThreadId = prevStoredJob?.threadId ?? null;
    }
  }

  const prompt =
    "You are now monitoring a Claude Code session for this project. " +
    "Explore the project structure, read key source files, review recent git commits, " +
    "and understand what is currently being built. " +
    "Build a complete mental model of the codebase. " +
    "Do not make any changes. " +
    "When /codex:shift is called you will receive a compacted summary of the Claude session " +
    "and further instructions.";

  const taskMetadata = { title: "Codex Monitor", summary: "Session monitor — building project context" };
  const job = buildTaskJob(workspaceRoot, taskMetadata, false);
  const request = buildTaskRequest({
    cwd, model, effort, prompt, write: false, resumeLast: false, jobId: job.id,
    resumeThreadId: prevCodexThreadId  // null for fresh, existing thread when resuming
  });
  const { payload } = enqueueBackgroundTask(cwd, job, request);

  // Track the new job against this shift session so future resumes reuse the thread
  setShiftSessionCodexJobId(workspaceRoot, shiftSessionId, job.id);

  const modeLabel = isResumed
    ? prevCodexThreadId
      ? "Resuming previous shift session (continuing Codex thread)"
      : "Resuming previous shift session (new Codex thread)"
    : "Starting fresh shift session";
  const rendered =
    `Codex monitor started in the background as ${payload.jobId}.\n` +
    `${modeLabel} (${shiftSessionId}).\n` +
    `Codex is now building context for this project.\n` +
    `Run /codex:shift when you are ready to hand off to Codex.\n`;

  outputCommandResult({ ...payload, shiftSessionId, resumed: isResumed }, rendered, options.json);
}

function tryLaunchCodexTerminal(cwd, threadId, contextPrompt) {
  // Try to copy context to clipboard (used when pre-send is unavailable)
  let clipboardCopied = false;
  if (contextPrompt) {
    for (const { cmd, args } of [
      { cmd: "xclip", args: ["-selection", "clipboard"] },
      { cmd: "xsel", args: ["--clipboard", "--input"] },
      { cmd: "pbcopy", args: [] }
    ]) {
      const which = spawnSync("which", [cmd], { encoding: "utf8" });
      if (which.status !== 0) continue;
      const proc = spawnSync(cmd, args, { input: contextPrompt, encoding: "utf8" });
      if (proc.status === 0) { clipboardCopied = true; break; }
    }
  }

  const codexCommand = `codex resume ${threadId}`;

  // 1. tmux — new window inside the current tmux session.
  //    When the IDE terminal runs inside tmux (common VS Code setup), this opens
  //    a new tab inside the IDE rather than a separate system window.
  if (process.env.TMUX) {
    const res = spawnSync("tmux", ["new-window", "-n", "codex", codexCommand], { encoding: "utf8" });
    if (res.status === 0) return { launched: true, terminal: "tmux", method: "new-window", clipboardCopied };
  }

  // 2. WezTerm — new tab via the WezTerm IPC CLI.
  if (process.env.WEZTERM_UNIX_SOCKET || process.env.WEZTERM_PANE) {
    const check = spawnSync("which", ["wezterm"], { encoding: "utf8" });
    if (check.status === 0) {
      const res = spawnSync("wezterm", ["cli", "spawn", "--", "bash", "-c", codexCommand], { encoding: "utf8" });
      if (res.status === 0) return { launched: true, terminal: "wezterm", method: "cli spawn", clipboardCopied };
    }
  }

  // 3. Zellij — new pane running the command.
  if (process.env.ZELLIJ) {
    const check = spawnSync("which", ["zellij"], { encoding: "utf8" });
    if (check.status === 0) {
      const res = spawnSync("zellij", ["run", "--name", "codex", "--", "bash", "-c", codexCommand], { encoding: "utf8" });
      if (res.status === 0) return { launched: true, terminal: "zellij", method: "run", clipboardCopied };
    }
  }

  // 4. System terminal emulators (fallback — opens outside the IDE).
  for (const { name, args } of [
    { name: "gnome-terminal", args: (c) => ["--", "bash", "-c", c] },
    { name: "xterm", args: (c) => ["-e", c] },
    { name: "konsole", args: (c) => ["-e", c] },
    { name: "xfce4-terminal", args: (c) => ["-e", c] },
    { name: "lxterminal", args: (c) => ["-e", c] },
    { name: "alacritty", args: (c) => ["-e", "bash", "-c", c] },
    { name: "kitty", args: (c) => ["bash", "-c", c] },
    { name: "x-terminal-emulator", args: (c) => ["-e", c] }
  ]) {
    const which = spawnSync("which", [name], { encoding: "utf8" });
    if (which.status !== 0) continue;
    try {
      const child = spawn(name, args(codexCommand), { cwd, detached: true, stdio: "ignore" });
      child.unref();
      return { launched: true, terminal: name, method: "system", clipboardCopied };
    } catch {
      // try next
    }
  }

  return { launched: false, terminal: null, method: null, clipboardCopied };
}

async function handleShift(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "session"],
    booleanOptions: ["json", "list-sessions", "launch"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);

  // --list-sessions: informational only
  if (options["list-sessions"]) {
    const sessions = listShiftSessions(workspaceRoot);
    const rendered = sessions.length === 0
      ? "No shift sessions found. Run /codex:monitor to start one.\n"
      : sessions.map((s) =>
          `${s.active ? "* " : "  "}${s.id}  (${s.turnCount} turns, started ${s.startedAt.slice(0, 10)}${s.resumed ? ", resumed" : ""})`
        ).join("\n") + "\n";
    outputCommandResult({ sessions }, rendered, options.json);
    return;
  }

  // Resolve which session(s) to use
  const allSessions = listShiftSessions(workspaceRoot);
  let compact = null;
  let chosenSession = null;

  if (options.session) {
    const rawPick = String(options.session);
    const asNumber = Number(rawPick);
    let sessionId;
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= allSessions.length) {
      sessionId = allSessions[asNumber - 1].id;
    } else {
      sessionId = rawPick;
    }
    chosenSession = allSessions.find((s) => s.id === sessionId) ?? null;
    if (!chosenSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    compact = compactShiftHistory(workspaceRoot, sessionId);
  } else {
    // No specific session — merge all
    compact = allSessions.length > 0 ? mergeAllShiftSessions(workspaceRoot) : null;
  }

  const contextBlock = formatCompactForPrompt(compact);

  // Resolve Codex threadId: prefer the tracked job from the chosen shift session,
  // then fall back to the current Claude session's most recent job.
  let threadId = null;
  if (chosenSession?.codexJobId) {
    const trackedJob = readStoredJob(workspaceRoot, chosenSession.codexJobId);
    threadId = trackedJob?.threadId ?? null;
  }
  if (!threadId) {
    // Fallback: look across all sessions' tracked jobs
    for (const s of allSessions) {
      if (!s.codexJobId) continue;
      const storedJob = readStoredJob(workspaceRoot, s.codexJobId);
      if (storedJob?.threadId) { threadId = storedJob.threadId; break; }
    }
  }
  if (!threadId) {
    // Last resort: current Claude session filter
    const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
    threadId = jobs.find((job) => job.threadId)?.threadId ?? null;
  }

  // Create git-diff markdown file in project root
  const now = new Date().toISOString().slice(0, 10);
  const SHIFT_EXCLUDE = [":(exclude).codex-shift-*.md"];
  const diffStat = spawnSync("git", ["diff", "--stat", "HEAD", "--", ".", ...SHIFT_EXCLUDE], { cwd, encoding: "utf8" });
  const diffFull = spawnSync("git", ["diff", "HEAD", "--", ".", ...SHIFT_EXCLUDE], { cwd, encoding: "utf8" });
  const logRecent = spawnSync("git", ["log", "--oneline", "-10"], { cwd, encoding: "utf8" });
  const untrackedResult = spawnSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--exclude=.codex-shift-*.md"],
    { cwd, encoding: "utf8" }
  );
  const untrackedFiles = (untrackedResult.stdout ?? "").trim().split("\n")
    .filter(Boolean)
    .filter((f) => !/^\.codex-shift-.*\.md$/.test(f));

  // Build untracked diff by running git diff --no-index /dev/null <file> for each
  const untrackedDiffParts = [];
  for (const file of untrackedFiles.slice(0, 20)) {
    const fileDiff = spawnSync("git", ["diff", "--no-index", "/dev/null", file], { cwd, encoding: "utf8" });
    if (fileDiff.stdout) untrackedDiffParts.push(fileDiff.stdout.trim());
  }

  const statBlock = [
    (diffStat.stdout ?? "").trim() || "",
    untrackedFiles.length > 0
      ? `\nUntracked files:\n${untrackedFiles.map((f) => `  ${f}`).join("\n")}`
      : ""
  ].join("").trim() || "(no changes)";

  const fullDiffBlock = [
    (diffFull.stdout ?? "").trim(),
    ...untrackedDiffParts
  ].filter(Boolean).join("\n") || "(no diff)";

  const mdLines = [
    `# Codex Shift — ${now}`,
    "",
    "## Recent Commits",
    "```",
    (logRecent.stdout ?? "").trim() || "(none)",
    "```",
    "",
    "## Changed Files",
    "```",
    statBlock,
    "```",
    "",
    "## Full Diff",
    "```diff",
    fullDiffBlock,
    "```"
  ];

  if (contextBlock) {
    const sessionLabel = chosenSession
      ? "## Claude Session Context"
      : `## Claude Session Context (merged from ${allSessions.length} sessions)`;
    mdLines.push("", sessionLabel, "", contextBlock);
  }

  const mdContent = mdLines.join("\n") + "\n";
  const mdPath = path.join(cwd, `.codex-shift-${now}.md`);
  fs.writeFileSync(mdPath, mdContent, "utf8");

  // Build the initial Codex prompt
  const contextSection = contextBlock
    ? `\n\n${contextBlock}`
    : "\n\n(No session history recorded yet — run /codex:monitor at the start of your next session.)";

  const codexPrompt =
    `Don't do anything with this query, just take context and follow my further instructions.\n` +
    contextSection;

  // When --launch is requested, pre-send the context to the Codex thread so it
  // is already processed when the user opens the terminal. This avoids needing
  // to paste anything manually.
  let preSendOk = false;
  let targetThreadId = threadId;
  if (options.launch && threadId) {
    process.stdout.write("Sending context to Codex...\n");
    try {
      ensureCodexAvailable(cwd);
      const result = await runAppServerTurn(workspaceRoot, {
        resumeThreadId: threadId,
        prompt: codexPrompt,
        sandbox: "read-only",
        persistThread: true
      });
      targetThreadId = result.threadId ?? threadId;
      preSendOk = true;
      process.stdout.write("Context delivered. Opening terminal...\n");
    } catch (err) {
      process.stdout.write(`Note: could not pre-send context (${err.message}). Paste it manually.\n`);
    }
  }

  // Launch terminal — pass contextPrompt only when pre-send failed (clipboard fallback)
  let launchResult = null;
  if (options.launch && targetThreadId) {
    launchResult = tryLaunchCodexTerminal(cwd, targetThreadId, preSendOk ? null : codexPrompt);
  }

  const resumeLine = targetThreadId
    ? `codex resume ${targetThreadId}`
    : "(no Codex thread found — run /codex:monitor first or start a /codex:rescue)";

  const sessionInfo = chosenSession
    ? `${chosenSession.id} (${chosenSession.turnCount} turn${chosenSession.turnCount !== 1 ? "s" : ""})`
    : `${allSessions.length} merged sessions`;

  let rendered;
  if (launchResult?.launched) {
    const inIde = launchResult.terminal === "tmux" || launchResult.terminal === "wezterm" || launchResult.terminal === "zellij";
    const where = inIde ? "IDE terminal" : "system terminal";
    const statusLine = preSendOk
      ? "Context already loaded — Codex is ready for your instructions."
      : launchResult.clipboardCopied
        ? "Context copied to clipboard — paste it as your first Codex message."
        : `Paste as your first Codex message:\n---\n${codexPrompt}\n---`;
    rendered = [
      "=== Codex Shift Ready ===",
      "",
      `Changes saved to: ${mdPath}`,
      `Context: ${sessionInfo}`,
      "",
      `Codex terminal opened in ${where} (${launchResult.terminal}).`,
      statusLine,
      ""
    ].join("\n");
  } else {
    const pasteBlock = preSendOk
      ? "(context already pre-loaded — just resume and start giving instructions)"
      : `Then send this as your first message to Codex:\n---\n${codexPrompt}\n---`;
    rendered = [
      "=== Codex Shift Ready ===",
      "",
      `Changes saved to: ${mdPath}`,
      `Context: ${sessionInfo}`,
      "",
      "Run this in a new terminal:",
      `  ${resumeLine}`,
      "",
      pasteBlock,
      ""
    ].join("\n");
  }

  const payload = {
    threadId: targetThreadId,
    mdPath,
    sessionCount: allSessions.length,
    chosenSessionId: chosenSession?.id ?? null,
    compact,
    resumeCommand: resumeLine,
    codexPrompt,
    preSendOk,
    launch: launchResult
  };

  outputCommandResult(payload, rendered, options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "monitor":
      await handleMonitor(argv);
      break;
    case "shift":
      await handleShift(argv);
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
