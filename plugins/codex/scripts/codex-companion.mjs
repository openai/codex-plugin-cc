#!/usr/bin/env node

import { spawn } from "node:child_process";
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
    importExternalAgentSession,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, isPidAlive, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  applyReduceOutcome,
  assignFindingIds,
  buildReducePrompt,
  buildShardDiff,
  buildShardPrompt,
  bySeverityThenConfidence,
  collectChangedFiles,
  DEFAULT_MAX_SHARDS,
  extractJsonPayload,
  extractSeamHints,
  mergeFindings,
  normalizeShardFinding,
  planShards,
  renderParallelReviewResult
} from "./lib/parallel-review.mjs";
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
const PARALLEL_REDUCE_SCHEMA = path.join(ROOT_DIR, "schemas", "parallel-reduce-output.schema.json");
const PARALLEL_SPAWN_STAGGER_MS = 3000;
const PARALLEL_POLL_INTERVAL_MS = 15000;
const PARALLEL_STALL_TIMEOUT_MS = 6 * 60_000;
const PARALLEL_PENDING_GRACE_MS = 90_000;
const PARALLEL_MAX_RETRIES_PER_SHARD = 1;
const DEFAULT_PARALLEL_TIMEOUT_MIN = 45;
const PARALLEL_RESUME_PROMPT =
  "Your previous review turn was interrupted before you produced the final answer. " +
  "Do not start over. Finish the adversarial review of your shard and return only the " +
  "final JSON object required by the structured output contract you were given earlier.";
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
      "  node scripts/codex-companion.mjs parallel-review [--base <ref>] [--scope <auto|working-tree|branch>] [--max-shards 4] [--invariants-file <path>] [--reduce-effort low] [--timeout-min 45] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/codex-companion.mjs transfer [--source <claude-jsonl>] [--json]",
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

  // An explicit thread id (e.g. from the parallel-review supervisor resuming a
  // dead shard) wins over the session-scoped latest-thread lookup, which is
  // ambiguous when several tasks are in flight.
  let resumeThreadId = request.resumeThreadId ?? null;
  if (!resumeThreadId && request.resumeLast) {
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
    ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
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
  if (kind === "parallel-review") {
    return "parallel-review";
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

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId
  };
}

function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Codex thread with visible turn history.",
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = await importExternalAgentSession(cwd, { sourcePath });
  const payload = {
    threadId: result.threadId,
    resumeCommand: `codex resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
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

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
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

function isTerminalJobStatus(status) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

async function recoverParallelChild({ cwd, workspaceRoot, child, record, reason, onProgress }) {
  if (child.retries >= PARALLEL_MAX_RETRIES_PER_SHARD) {
    child.terminal = true;
    child.finalStatus = `unrecovered (${reason})`;
    onProgress?.({ message: `${child.label}: ${reason}; retry budget exhausted.` });
    return;
  }
  child.retries += 1;
  onProgress?.({ message: `${child.label}: ${reason}; recovering (attempt ${child.retries}/${PARALLEL_MAX_RETRIES_PER_SHARD}).` });

  const storedJob = record ?? readStoredJob(workspaceRoot, child.jobId);
  if (storedJob) {
    try {
      await cancelJobRecord(cwd, workspaceRoot, storedJob, "Cancelled by the parallel-review supervisor after the worker stopped responding.");
    } catch {
      // The worker may already be gone; respawning below is what matters.
    }
  }

  // A persisted thread id means the Codex thread still holds the original
  // prompt and any analysis done before the crash — resume it instead of
  // paying for a fresh start.
  const threadId = storedJob?.threadId ?? null;
  const job = buildTaskJob(workspaceRoot, { title: child.title, summary: child.summary }, false);
  const request = buildTaskRequest({
    cwd,
    model: child.model,
    effort: child.effort,
    prompt: threadId ? PARALLEL_RESUME_PROMPT : child.prompt,
    write: false,
    resumeLast: false,
    jobId: job.id
  });
  if (threadId) {
    request.resumeThreadId = threadId;
  }
  request.outputSchema = child.outputSchema;
  enqueueBackgroundTask(cwd, job, request);
  child.jobId = job.id;
  child.jobIds.push(job.id);
  child.lastSpawnAt = Date.now();
  onProgress?.({ message: `${child.label}: ${threadId ? "resumed its thread" : "respawned fresh"} as ${job.id}.` });
}

async function superviseParallelJobs({ cwd, workspaceRoot, children, deadline, onProgress }) {
  for (;;) {
    let active = 0;
    for (const child of children) {
      if (child.terminal) {
        continue;
      }
      const record = readStoredJob(workspaceRoot, child.jobId);

      if (!record) {
        // Right after enqueueing, the detached worker may not have written its
        // job file yet; that is pending, not dead.
        if (Date.now() - child.lastSpawnAt < PARALLEL_PENDING_GRACE_MS) {
          active += 1;
        } else {
          await recoverParallelChild({ cwd, workspaceRoot, child, record: null, reason: "its job record disappeared", onProgress });
          if (!child.terminal) {
            active += 1;
          }
        }
        continue;
      }

      if (isTerminalJobStatus(record.status)) {
        child.terminal = true;
        child.finalStatus = record.status;
        child.record = record;
        const completedAt = record.completedAt ? Date.parse(record.completedAt) : Date.now();
        child.wallSec = Math.max(0, Math.round((completedAt - child.firstSpawnAt) / 1000));
        onProgress?.({ message: `${child.label}: ${record.status} after ${child.wallSec}s.` });
        continue;
      }

      // The job record can say "running" long after the worker died; trust the
      // OS over the record, and treat a silent log as a hung turn.
      const pidDead = record.pid != null && !isPidAlive(record.pid);
      let stalled = false;
      if (!pidDead && record.status === "running" && record.logFile && fs.existsSync(record.logFile)) {
        stalled = Date.now() - fs.statSync(record.logFile).mtimeMs > PARALLEL_STALL_TIMEOUT_MS;
      }
      if (pidDead || stalled) {
        await recoverParallelChild({
          cwd,
          workspaceRoot,
          child,
          record,
          reason: pidDead ? "its worker process is dead while the job still reports running" : "it has made no log progress",
          onProgress
        });
        if (!child.terminal) {
          active += 1;
        }
        continue;
      }

      active += 1;
    }

    if (active === 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        "Parallel review timed out with jobs still active; they are being cancelled. Rerun with a longer --timeout-min or fewer shards."
      );
    }
    await sleep(PARALLEL_POLL_INTERVAL_MS);
  }
}

async function executeParallelReviewRun(request) {
  const { cwd, workspaceRoot, target, plan, focusText, invariantsText, model, effort, reduceEffort, timeoutMs, onProgress } = request;
  const runLabel = request.jobId ? `parallel-review ${request.jobId}` : "parallel-review";
  const seams = extractSeamHints({
    files: plan.files,
    shards: plan.shards,
    readFileContent: (relativePath) => {
      try {
        return fs.readFileSync(path.join(cwd, relativePath), "utf8");
      } catch {
        return null;
      }
    }
  });
  const shardSchema = readOutputSchema(REVIEW_SCHEMA);
  const reduceSchema = readOutputSchema(PARALLEL_REDUCE_SCHEMA);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const children = [];

  onProgress?.({
    message: `Sharding ${plan.fileCount} files (~${plan.totalLines} changed lines) into ${plan.shards.length} concurrent reviews.`,
    phase: "starting"
  });

  try {
    for (const shard of plan.shards) {
      const diff = buildShardDiff(cwd, target, shard);
      const prompt = buildShardPrompt(ROOT_DIR, {
        runLabel,
        shard,
        shardCount: plan.shards.length,
        targetLabel: target.label,
        invariantsText,
        focusText,
        diff
      });
      const title = `Codex Parallel Shard ${shard.id}`;
      const summary = `Shard ${shard.id}: ${shard.files.length} files of ${target.label}`;
      const job = buildTaskJob(workspaceRoot, { title, summary }, false);
      const taskRequest = buildTaskRequest({ cwd, model, effort, prompt, write: false, resumeLast: false, jobId: job.id });
      taskRequest.outputSchema = shardSchema;
      enqueueBackgroundTask(cwd, job, taskRequest);
      children.push({
        kind: "shard",
        shard,
        label: `Shard ${shard.id}`,
        title,
        summary,
        jobId: job.id,
        jobIds: [job.id],
        prompt,
        outputSchema: shardSchema,
        model,
        effort,
        firstSpawnAt: Date.now(),
        lastSpawnAt: Date.now(),
        retries: 0,
        terminal: false,
        finalStatus: null,
        record: null
      });
      onProgress?.({ message: `Spawned shard ${shard.id} (${shard.files.length} files, ~${shard.weight} lines) as ${job.id}.` });
      if (shard !== plan.shards[plan.shards.length - 1]) {
        // Concurrent job-state writers race; give each enqueue a head start.
        await sleep(PARALLEL_SPAWN_STAGGER_MS);
      }
    }

    await superviseParallelJobs({ cwd, workspaceRoot, children, deadline, onProgress });

    const rawFindings = [];
    const unparsed = [];
    const shardReports = [];
    for (const child of children) {
      const record = child.record ?? readStoredJob(workspaceRoot, child.jobId);
      const report = {
        shard: child.shard.id,
        jobId: child.jobId,
        status: child.finalStatus ?? "unknown",
        wallSec: child.wallSec ?? null,
        retries: child.retries,
        verdict: null,
        summary: null,
        findingCount: 0
      };
      shardReports.push(report);
      const extraction = extractJsonPayload(record?.result?.rawOutput ?? "", (parsed) => Array.isArray(parsed.findings));
      if (!extraction.payload) {
        unparsed.push({ shard: child.shard.id, jobId: child.jobId, error: extraction.error });
        continue;
      }
      report.verdict = extraction.payload.verdict ?? null;
      report.summary = extraction.payload.summary ?? null;
      report.findingCount = extraction.payload.findings.length;
      for (const raw of extraction.payload.findings) {
        rawFindings.push(normalizeShardFinding(raw, child.shard.id));
      }
    }
    const findings = assignFindingIds(mergeFindings(rawFindings));

    // The reduce pass is mandatory even when every shard approved: a defect
    // whose cause is in one shard and whose victim is in another is invisible
    // to both, and only this pass reads across the boundary.
    onProgress?.({ message: `Merged ${findings.length} findings; starting the cross-shard integration pass.`, phase: "reviewing" });
    const reducePrompt = buildReducePrompt(ROOT_DIR, {
      runLabel,
      targetLabel: target.label,
      shards: plan.shards,
      findings,
      seams,
      unparsedCount: unparsed.length
    });
    const reduceJob = buildTaskJob(
      workspaceRoot,
      { title: "Codex Parallel Reduce", summary: `Integration pass over ${findings.length} findings` },
      false
    );
    const reduceRequest = buildTaskRequest({
      cwd,
      model,
      effort: reduceEffort,
      prompt: reducePrompt,
      write: false,
      resumeLast: false,
      jobId: reduceJob.id
    });
    reduceRequest.outputSchema = reduceSchema;
    enqueueBackgroundTask(cwd, reduceJob, reduceRequest);
    const reduceChild = {
      kind: "reduce",
      shard: { id: "reduce", files: [] },
      label: "Reduce",
      title: "Codex Parallel Reduce",
      summary: `Integration pass over ${findings.length} findings`,
      jobId: reduceJob.id,
      jobIds: [reduceJob.id],
      prompt: reducePrompt,
      outputSchema: reduceSchema,
      model,
      effort: reduceEffort,
      firstSpawnAt: Date.now(),
      lastSpawnAt: Date.now(),
      retries: 0,
      terminal: false,
      finalStatus: null,
      record: null
    };
    children.push(reduceChild);
    await superviseParallelJobs({ cwd, workspaceRoot, children, deadline, onProgress });

    const reduceRecord = reduceChild.record ?? readStoredJob(workspaceRoot, reduceChild.jobId);
    const reduceReport = {
      jobId: reduceChild.jobId,
      status: reduceChild.finalStatus ?? "unknown",
      wallSec: reduceChild.wallSec ?? null,
      summary: null,
      assessed: 0,
      seamFindingCount: 0
    };
    let seamFindings = [];
    const reduceExtraction = extractJsonPayload(
      reduceRecord?.result?.rawOutput ?? "",
      (parsed) => Array.isArray(parsed.assessments) || Array.isArray(parsed.seam_findings)
    );
    if (reduceExtraction.payload) {
      const outcome = applyReduceOutcome(findings, reduceExtraction.payload);
      seamFindings = outcome.seamFindings;
      reduceReport.summary = reduceExtraction.payload.summary ?? null;
      reduceReport.assessed = outcome.assessed;
      reduceReport.seamFindingCount = seamFindings.length;
    } else {
      reduceReport.error = reduceExtraction.error;
    }

    const payload = {
      review: "Parallel Review",
      target,
      shards: shardReports,
      reduce: reduceReport,
      findings: [...findings, ...seamFindings].sort(bySeverityThenConfidence),
      unparsed,
      seams,
      totals: { wallSec: Math.round((Date.now() - startedAt) / 1000), shardCount: plan.shards.length }
    };
    const degraded = shardReports.some((report) => report.status !== "completed") || Boolean(reduceReport.error);

    return {
      exitStatus: degraded ? 1 : 0,
      payload,
      rendered: renderParallelReviewResult(payload),
      summary: reduceReport.summary ?? `Parallel review finished with ${payload.findings.length} findings.`,
      jobTitle: "Codex Parallel Review",
      jobClass: "review",
      targetLabel: target.label
    };
  } finally {
    // Never exit with children still queued or running, whatever went wrong.
    for (const child of children) {
      if (child.terminal) {
        continue;
      }
      const record = readStoredJob(workspaceRoot, child.jobId);
      if (record && !isTerminalJobStatus(record.status)) {
        try {
          await cancelJobRecord(cwd, workspaceRoot, record, "Cancelled because the parallel-review orchestrator exited.");
        } catch {
          // Best-effort teardown.
        }
      }
    }
  }
}

async function handleParallelReview(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "reduce-effort", "max-shards", "invariants-file", "timeout-min", "cwd"],
    booleanOptions: ["json"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  ensureCodexAvailable(cwd);
  ensureGitRepository(cwd);

  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const reduceEffort = normalizeReasoningEffort(options["reduce-effort"]) ?? "low";
  const maxShards = Math.max(2, Number.parseInt(options["max-shards"] ?? `${DEFAULT_MAX_SHARDS}`, 10) || DEFAULT_MAX_SHARDS);
  const timeoutMs =
    Math.max(1, Number.parseInt(options["timeout-min"] ?? `${DEFAULT_PARALLEL_TIMEOUT_MIN}`, 10) || DEFAULT_PARALLEL_TIMEOUT_MIN) * 60_000;
  const focusText = positionals.join(" ").trim();
  const invariantsText = options["invariants-file"]
    ? fs.readFileSync(path.resolve(cwd, options["invariants-file"]), "utf8")
    : "";

  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });
  const files = collectChangedFiles(cwd, target);
  if (files.length === 0) {
    throw new Error(`No changes found for ${target.label}.`);
  }
  const plan = planShards(files, maxShards);

  if (plan.mode === "single") {
    // Below the gate a sharded run costs ~k× tokens with no wall-time win;
    // run the existing single adversarial review instead.
    const metadata = buildReviewJobMetadata("Adversarial Review", target);
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
          model,
          focusText,
          reviewName: "Adversarial Review",
          onProgress: progress
        }),
      { json: options.json }
    );
    return;
  }

  plan.files = files;
  const job = createCompanionJob({
    prefix: "review",
    kind: "parallel-review",
    title: "Codex Parallel Review",
    workspaceRoot,
    jobClass: "review",
    summary: `Parallel review ${target.label} (${plan.shards.length} shards)`
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeParallelReviewRun({
        cwd,
        workspaceRoot,
        target,
        plan,
        focusText,
        invariantsText,
        model,
        effort,
        reduceEffort,
        timeoutMs,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
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

async function cancelJobRecord(cwd, workspaceRoot, job, reason = "Cancelled by user.") {
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;
  const logFile = job.logFile ?? existing.logFile ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? existing.pid ?? Number.NaN);
  appendLogLine(logFile, reason);

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: reason
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
    errorMessage: reason,
    completedAt
  });

  return { nextJob, interrupt };
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const { nextJob, interrupt } = await cancelJobRecord(cwd, workspaceRoot, job);

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
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
    case "parallel-review":
      await handleParallelReview(argv);
      break;
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
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
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
