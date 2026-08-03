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
const PARALLEL_MAX_SHARDS_LIMIT = 8;
const PARALLEL_STALL_TIMEOUT_MS = 6 * 60_000;
// Delta notifications are opted out at initialize, so a live turn can
// legitimately go minutes without log activity while the model reasons;
// only a much longer silence marks a live-pid worker as hung.
const PARALLEL_LIVE_STALL_TIMEOUT_MS = 15 * 60_000;
const PARALLEL_PENDING_GRACE_MS = 90_000;
const PARALLEL_MAX_RETRIES_PER_SHARD = 1;
const DEFAULT_PARALLEL_TIMEOUT_MIN = 45;
const PARALLEL_RESUME_PROMPT =
  "Your previous review turn was interrupted before you produced the final answer. " +
  "Do not start over. Finish the adversarial review of your shard and return only the " +
  "final JSON object required by the structured output contract you were given earlier.";
const PARALLEL_REDUCE_RESUME_PROMPT =
  "Your previous integration turn was interrupted before you produced the final answer. " +
  "Do not start over. Finish the cross-shard integration pass — assess every finding and " +
  "hunt seam defects that span shards — and return only the final JSON object required by " +
  "the structured output contract you were given earlier.";
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
        job.resumable !== false &&
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
  const activeTask = visibleJobs.find(
    (job) => job.jobClass === "task" && job.resumable !== false && (job.status === "queued" || job.status === "running")
  );
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
    // Internal jobs (parallel shards/reduce) override the name so the
    // TASK_THREAD_PREFIX search in findLatestTaskThread never matches them.
    threadName: resumeThreadId ? null : (request.threadName ?? buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT))
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

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false, resumable = true }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write,
    ...(resumable ? {} : { resumable: false })
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

function buildTaskJob(workspaceRoot, taskMetadata, write, options = {}) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write,
    resumable: options.resumable ?? true
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId, threadName }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId,
    ...(threadName ? { threadName } : {})
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

async function recoverParallelChild({ cwd, workspaceRoot, child, record, reason, onChildrenChanged, onProgress }) {
  if (child.retries >= PARALLEL_MAX_RETRIES_PER_SHARD) {
    child.terminal = true;
    child.finalStatus = `unrecovered (${reason})`;
    // A stalled worker can still be alive; stop it now instead of letting it
    // burn tokens until the orchestrator exits.
    const abandonedJob = record ?? readStoredJob(workspaceRoot, child.jobId);
    if (abandonedJob && !isTerminalJobStatus(abandonedJob.status)) {
      try {
        await cancelJobRecord(
          cwd,
          workspaceRoot,
          abandonedJob,
          "Cancelled by the parallel-review supervisor after its retry budget was exhausted."
        );
      } catch {
        // Best-effort; the exit teardown sweeps every attempt again.
      }
    }
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
  // The reduce pass and shard reviews have different jobs to finish; resuming
  // a reduce thread with the shard prompt would tell it to review "your shard"
  // and abandon the integration pass.
  const resumePrompt = child.kind === "reduce" ? PARALLEL_REDUCE_RESUME_PROMPT : PARALLEL_RESUME_PROMPT;
  const job = buildTaskJob(workspaceRoot, { title: child.title, summary: child.summary }, false, { resumable: false });
  const request = buildTaskRequest({
    cwd,
    model: child.model,
    effort: child.effort,
    prompt: threadId ? resumePrompt : child.prompt,
    write: false,
    resumeLast: false,
    jobId: job.id,
    threadName: child.title
  });
  if (threadId) {
    request.resumeThreadId = threadId;
  }
  request.outputSchema = child.outputSchema;
  child.jobId = job.id;
  child.jobIds.push(job.id);
  child.lastSpawnAt = Date.now();
  // Persist before the spawn so a cancel can never race it.
  onChildrenChanged?.();
  enqueueBackgroundTask(cwd, job, request);
  onProgress?.({ message: `${child.label}: ${threadId ? "resumed its thread" : "respawned fresh"} as ${job.id}.` });
}

async function superviseParallelJobs({ cwd, workspaceRoot, children, deadline, onChildrenChanged, onProgress }) {
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
          await recoverParallelChild({
            cwd,
            workspaceRoot,
            child,
            record: null,
            reason: "its job record disappeared",
            onChildrenChanged,
            onProgress
          });
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
      // OS over the record. A silent log marks a hung turn, but a live "running"
      // worker gets the long threshold — reasoning stretches emit no events.
      // "queued" is normally a sub-second window before the worker flips to
      // "running", so a queued record silent past the short threshold is a
      // wedged startup (or a lost status write) and gets recovered sooner.
      const pidDead = record.pid != null && !isPidAlive(record.pid);
      let stalled = false;
      if (
        !pidDead &&
        (record.status === "running" || record.status === "queued") &&
        record.logFile &&
        fs.existsSync(record.logFile)
      ) {
        const silentMs = Date.now() - fs.statSync(record.logFile).mtimeMs;
        const stallLimitMs = record.status === "queued" ? PARALLEL_STALL_TIMEOUT_MS : PARALLEL_LIVE_STALL_TIMEOUT_MS;
        stalled = silentMs > stallLimitMs;
        if (!stalled && record.status === "running" && silentMs > PARALLEL_STALL_TIMEOUT_MS) {
          if (!child.stallWarned) {
            child.stallWarned = true;
            onProgress?.({
              message: `${child.label}: no log progress for ${Math.round(silentMs / 60_000)}m; worker is still alive — recovering only after ${Math.round(PARALLEL_LIVE_STALL_TIMEOUT_MS / 60_000)}m of silence.`
            });
          }
        } else if (silentMs <= PARALLEL_STALL_TIMEOUT_MS) {
          child.stallWarned = false;
        }
      }
      if (pidDead || stalled) {
        await recoverParallelChild({
          cwd,
          workspaceRoot,
          child,
          record,
          reason: pidDead ? "its worker process is dead while the job still reports running" : "it has made no log progress",
          onChildrenChanged,
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
        const absolute = path.join(cwd, relativePath);
        // Seam scanning is a heuristic; skip pathological files (generated
        // bundles) rather than loading them whole.
        if (fs.statSync(absolute).size > 1_000_000) {
          return null;
        }
        return fs.readFileSync(absolute, "utf8");
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

  // /codex:cancel on the orchestrator kills this process before the finally
  // teardown can run; the persisted list lets cancelJobRecord cascade to the
  // detached shard/reduce workers instead of orphaning them.
  const persistChildJobIds = () => {
    if (!request.jobId) {
      return;
    }
    const stored = readStoredJob(workspaceRoot, request.jobId);
    if (!stored) {
      return;
    }
    writeJobFile(workspaceRoot, request.jobId, {
      ...stored,
      childJobIds: children.flatMap((child) => child.jobIds)
    });
  };

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
      // Shard and reduce jobs are internal to this run; they must never win
      // the task --resume-last lookup or block it as an active user task.
      const job = buildTaskJob(workspaceRoot, { title, summary }, false, { resumable: false });
      const taskRequest = buildTaskRequest({
        cwd,
        model,
        effort,
        prompt,
        write: false,
        resumeLast: false,
        jobId: job.id,
        threadName: title
      });
      taskRequest.outputSchema = shardSchema;
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
      // Persist before the spawn so a cancel can never race it; an id whose
      // spawn failed has no record and the cascade skips it.
      persistChildJobIds();
      enqueueBackgroundTask(cwd, job, taskRequest);
      onProgress?.({ message: `Spawned shard ${shard.id} (${shard.files.length} files, ~${shard.weight} lines) as ${job.id}.` });
      if (shard !== plan.shards[plan.shards.length - 1]) {
        // Concurrent job-state writers race; give each enqueue a head start.
        await sleep(PARALLEL_SPAWN_STAGGER_MS);
      }
    }

    await superviseParallelJobs({ cwd, workspaceRoot, children, deadline, onChildrenChanged: persistChildJobIds, onProgress });

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
        findingCount: 0,
        outOfScope: 0
      };
      shardReports.push(report);
      // Mirror the review schema's required contract: a truncated object that
      // parses but lacks required fields is a dropped shard, not a clean one.
      const extraction = extractJsonPayload(
        record?.result?.rawOutput ?? "",
        (parsed) =>
          typeof parsed.verdict === "string" &&
          typeof parsed.summary === "string" &&
          Array.isArray(parsed.findings) &&
          Array.isArray(parsed.next_steps)
      );
      if (!extraction.payload) {
        unparsed.push({ shard: child.shard.id, jobId: child.jobId, error: extraction.error });
        continue;
      }
      report.verdict = extraction.payload.verdict ?? null;
      report.summary = extraction.payload.summary ?? null;
      // The shard prompt promises findings outside the shard's file list are
      // discarded; enforce that here so out-of-lane guesses cannot seed
      // duplicates — cross-file defects are the reduce pass's job.
      const ownedPaths = new Set(child.shard.files.map((file) => file.path));
      for (const raw of extraction.payload.findings) {
        const finding = normalizeShardFinding(raw, child.shard.id);
        if (!ownedPaths.has(finding.file.replace(/^\.\//, ""))) {
          report.outOfScope += 1;
          continue;
        }
        report.findingCount += 1;
        rawFindings.push(finding);
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
      false,
      { resumable: false }
    );
    const reduceRequest = buildTaskRequest({
      cwd,
      model,
      effort: reduceEffort,
      prompt: reducePrompt,
      write: false,
      resumeLast: false,
      jobId: reduceJob.id,
      threadName: "Codex Parallel Reduce"
    });
    reduceRequest.outputSchema = reduceSchema;
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
    persistChildJobIds();
    enqueueBackgroundTask(cwd, reduceJob, reduceRequest);
    await superviseParallelJobs({ cwd, workspaceRoot, children, deadline, onChildrenChanged: persistChildJobIds, onProgress });

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
    // The reduce contract requires all three fields; an explicit (possibly
    // empty) seam_findings array is the evidence the seam hunt actually ran.
    const reduceExtraction = extractJsonPayload(
      reduceRecord?.result?.rawOutput ?? "",
      (parsed) =>
        typeof parsed.summary === "string" && Array.isArray(parsed.assessments) && Array.isArray(parsed.seam_findings)
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
    // A shard that completed but produced non-schema output contributed no
    // findings, a failed reduce turn can still leave parseable partial output
    // behind, and a truncated reduce can parse yet skip finding ids — every
    // one of those runs is incomplete, not successful.
    const degraded =
      shardReports.some((report) => report.status !== "completed") ||
      unparsed.length > 0 ||
      reduceReport.status !== "completed" ||
      reduceReport.assessed < findings.length ||
      Boolean(reduceReport.error);

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
    // Sweep every attempt (child.jobIds), not just the latest: a recovery whose
    // cancel failed, or a child marked terminal while its worker is still
    // alive, would otherwise escape teardown.
    for (const child of children) {
      for (const attemptJobId of child.jobIds) {
        const record = readStoredJob(workspaceRoot, attemptJobId);
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
  // Git prints root-relative paths, and shard pathspecs plus seam reads
  // resolve against the run directory — anchor the whole run at the repo root
  // so invoking from a subdirectory cannot produce empty shard diffs.
  const repoRoot = ensureGitRepository(cwd);

  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const reduceEffort = normalizeReasoningEffort(options["reduce-effort"]) ?? "low";
  // Every shard costs jobs (two attempts each, plus the reduce and the parent
  // record) against the workspace's 50-slot retention cap; the clamp keeps a
  // worst-case run well inside it.
  const maxShards = Math.min(
    PARALLEL_MAX_SHARDS_LIMIT,
    Math.max(2, Number.parseInt(options["max-shards"] ?? `${DEFAULT_MAX_SHARDS}`, 10) || DEFAULT_MAX_SHARDS)
  );
  const timeoutMs =
    Math.max(1, Number.parseInt(options["timeout-min"] ?? `${DEFAULT_PARALLEL_TIMEOUT_MIN}`, 10) || DEFAULT_PARALLEL_TIMEOUT_MIN) * 60_000;
  const focusText = positionals.join(" ").trim();
  const invariantsText = options["invariants-file"]
    ? fs.readFileSync(path.resolve(cwd, options["invariants-file"]), "utf8")
    : "";

  const target = resolveReviewTarget(repoRoot, {
    base: options.base,
    scope: options.scope
  });
  const files = collectChangedFiles(repoRoot, target);
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
          cwd: repoRoot,
          base: options.base,
          scope: options.scope,
          model,
          // The single fallback must still honor the shared invariant list the
          // sharded path would have given every shard.
          focusText: invariantsText
            ? [focusText, `Shared invariants that must hold for this change:\n${invariantsText.trim()}`]
                .filter(Boolean)
                .join("\n\n")
            : focusText,
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
        cwd: repoRoot,
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

async function cancelJobRecord(cwd, workspaceRoot, job, reason = "Cancelled by user.", cancelledIds = new Set()) {
  cancelledIds.add(job.id);
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

  // Re-read after the terminate: a parallel-review orchestrator may have
  // persisted more child job ids between the first read and its death.
  const latest = readStoredJob(workspaceRoot, job.id) ?? existing;

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
    ...latest,
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

  // A cancelled parallel-review orchestrator dies before its own teardown can
  // run, and its shard/reduce workers are detached processes that survive the
  // tree kill above — cancel them from the persisted child list.
  const childJobIds = Array.isArray(latest.childJobIds) ? latest.childJobIds : [];
  for (const childJobId of childJobIds) {
    if (cancelledIds.has(childJobId)) {
      continue;
    }
    const childRecord = readStoredJob(workspaceRoot, childJobId);
    if (childRecord && !isTerminalJobStatus(childRecord.status)) {
      try {
        await cancelJobRecord(cwd, workspaceRoot, childRecord, "Cancelled with its parallel-review parent.", cancelledIds);
      } catch {
        // Best-effort cascade; remaining children stay visible in status.
      }
    }
  }

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
