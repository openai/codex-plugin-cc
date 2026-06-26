/**
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").ReviewTarget} ReviewTarget
 * @typedef {import("./app-server-protocol").ThreadItem} ThreadItem
 * @typedef {import("./app-server-protocol").ThreadResumeParams} ThreadResumeParams
 * @typedef {import("./app-server-protocol").ThreadStartParams} ThreadStartParams
 * @typedef {import("./app-server-protocol").Turn} Turn
 * @typedef {import("./app-server-protocol").UserInput} UserInput
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 * @typedef {{
 *   threadId: string,
 *   rootThreadId: string,
 *   threadIds: Set<string>,
 *   threadTurnIds: Map<string, string>,
 *   threadLabels: Map<string, string>,
 *   turnId: string | null,
 *   pendingTurnId: string | null,
 *   bufferedNotifications: AppServerNotification[],
 *   completion: Promise<TurnCaptureState>,
 *   resolveCompletion: (state: TurnCaptureState) => void,
 *   rejectCompletion: (error: unknown) => void,
 *   finalTurn: Turn | null,
 *   completed: boolean,
 *   finalAnswerSeen: boolean,
 *   sawSubagentWork: boolean,
 *   inferredCompletionQuietMs: number,
 *   pendingCollaborations: Set<string>,
 *   activeSubagentTurns: Set<string>,
 *   completionTimer: ReturnType<typeof setTimeout> | null,
 *   lastAgentMessage: string,
 *   reviewText: string,
 *   reasoningSummary: string[],
 *   error: unknown,
 *   messages: Array<{ lifecycle: string, phase: string | null, text: string }>,
 *   fileChanges: ThreadItem[],
 *   commandExecutions: ThreadItem[],
 *   onProgress: ProgressReporter | null
 * }} TurnCaptureState
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFile } from "./fs.mjs";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, CodexAppServerClient } from "./app-server.mjs";
import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { binaryAvailable } from "./process.mjs";

const SERVICE_NAME = "claude_code_codex_plugin";
const TASK_THREAD_PREFIX = "Codex Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
// A REVIEW turn that produces no notifications and no response for this long is
// treated as a stalled upstream connection and aborted, instead of the RPC
// promise hanging forever (it only settles on a response or a full socket
// close, neither of which happens on a half-dead "Reconnecting..." link).
// The timer is reset on every progress notification, so a slow-but-healthy
// turn running many commands is never killed — only true silence triggers it.
//
// This default is REVIEW-ONLY. It must NOT be injected by the shared
// runAppServerTurn/runAppServerInvestigation runners, because /codex:task also
// calls runAppServerTurn: a long-thinking or long-single-command task would
// otherwise be aborted at this threshold with no task-level way to raise or
// disable it. Review callers opt in via resolveReviewTurnIdleTimeoutMs(); the
// runners pass whatever they are given straight through to captureTurn, which
// arms no watchdog for an absent/invalid value.
const DEFAULT_TURN_IDLE_TIMEOUT_MS = 180_000;

// Demoted-inference quiet window (Defect A). Inferred turn completion is a
// FALLBACK for the subagent/collab case where the main thread never emits a
// real turn/completed. It is eligible only after (a) the turn actually spawned
// subagent/collab work, (b) that work has drained, and (c) the turn has been
// silent for this long with no turn/completed. The window re-arms on every
// belonging item/message, so only genuine silence triggers it. Plain recon
// turns never infer — they wait for the real turn/completed.
const DEFAULT_INFERRED_COMPLETION_QUIET_MS = 15_000;

function resolveInferredCompletionQuietMs(explicitMs) {
  if (Number.isFinite(explicitMs) && explicitMs > 0) {
    return explicitMs;
  }
  const fromEnv = Number(process.env.CODEX_INFERRED_COMPLETION_QUIET_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_INFERRED_COMPLETION_QUIET_MS;
}

/**
 * Resolve the idle-watchdog timeout for REVIEW turns. Returns the review
 * default when no explicit positive value is supplied. Task runs do not call
 * this and therefore run without an idle watchdog.
 * @param {number | null | undefined} explicitMs
 * @returns {number}
 */
export function resolveReviewTurnIdleTimeoutMs(explicitMs) {
  return Number.isFinite(explicitMs) && explicitMs > 0 ? explicitMs : DEFAULT_TURN_IDLE_TIMEOUT_MS;
}

const EXTERNAL_AGENT_IMPORT_COMPLETED = "externalAgentConfig/import/completed";
const EXTERNAL_AGENT_IMPORT_TIMEOUT_MS = 2 * 60 * 1000;

function cleanCodexStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}

/** @returns {ThreadStartParams} */
function buildThreadParams(cwd, options = {}) {
  return {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true
  };
}

/** @returns {ThreadResumeParams} */
function buildResumeParams(threadId, cwd, options = {}) {
  return {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only"
  };
}

/** @returns {UserInput[]} */
function buildTurnInput(prompt) {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function extractThreadId(message) {
  return message?.params?.threadId ?? null;
}

function extractTurnId(message) {
  if (message?.params?.turnId) {
    return message.params.turnId;
  }
  if (message?.params?.turn?.id) {
    return message.params.turn.id;
  }
  return null;
}

function collectTouchedFiles(fileChanges) {
  const paths = new Set();
  for (const fileChange of fileChanges) {
    for (const change of fileChange.changes ?? []) {
      if (change.path) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
}

function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function extractReasoningSections(value) {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return extractReasoningSections(value.text);
    }
    if ("summary" in value) {
      return extractReasoningSections(value.summary);
    }
    if ("content" in value) {
      return extractReasoningSections(value.content);
    }
    if ("parts" in value) {
      return extractReasoningSections(value.parts);
    }
  }

  return [];
}

function mergeReasoningSections(existingSections, nextSections) {
  const merged = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

/**
 * @param {ProgressReporter | null | undefined} onProgress
 * @param {string | null | undefined} message
 * @param {string | null | undefined} [phase]
 */
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function labelForThread(state, threadId) {
  if (!threadId || threadId === state.rootThreadId || threadId === state.threadId) {
    return null;
  }
  return state.threadLabels.get(threadId) ?? threadId;
}

function registerThread(state, threadId, options = {}) {
  if (!threadId) {
    return;
  }

  state.threadIds.add(threadId);
  const label =
    options.threadName ??
    options.name ??
    options.agentNickname ??
    options.agentRole ??
    state.threadLabels.get(threadId) ??
    null;
  if (label) {
    state.threadLabels.set(threadId, label);
  }
}

function describeStartedItem(state, item) {
  switch (item.type) {
    case "enteredReviewMode":
      return { message: `Reviewer started: ${item.review}`, phase: "reviewing" };
    case "commandExecution":
      return {
        message: `Running command: ${shorten(item.command, 96)}`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    case "fileChange":
      return { message: `Applying ${item.changes.length} file change(s).`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Calling ${item.server}/${item.tool}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Running tool: ${item.tool}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Starting subagent ${subagents.join(", ")} via collaboration tool: ${item.tool}.`
          : `Starting collaboration tool: ${item.tool}.`;
      return { message: summary, phase: "investigating" };
    }
    case "webSearch":
      return { message: `Searching: ${shorten(item.query, 96)}`, phase: "investigating" };
    default:
      return null;
  }
}

function describeCompletedItem(state, item) {
  switch (item.type) {
    case "commandExecution": {
      const exitCode = item.exitCode ?? "?";
      const statusLabel = item.status === "completed" ? "completed" : item.status;
      return {
        message: `Command ${statusLabel}: ${shorten(item.command, 96)} (exit ${exitCode})`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    }
    case "fileChange":
      return { message: `File changes ${item.status}.`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Tool ${item.server}/${item.tool} ${item.status}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Tool ${item.tool} ${item.status}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Subagent ${subagents.join(", ")} ${item.status}.`
          : `Collaboration tool ${item.tool} ${item.status}.`;
      return { message: summary, phase: "investigating" };
    }
    case "exitedReviewMode":
      return { message: "Reviewer finished.", phase: "finalizing" };
    default:
      return null;
  }
}

/** @returns {TurnCaptureState} */
function createTurnCaptureState(threadId, options = {}) {
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    turnId: null,
    pendingTurnId: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    sawSubagentWork: false,
    inferredCompletionQuietMs: resolveInferredCompletionQuietMs(options.inferredCompletionQuietMs),
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    lastAgentMessage: "",
    reviewText: "",
    reasoningSummary: [],
    error: null,
    messages: [],
    fileChanges: [],
    commandExecutions: [],
    onProgress: options.onProgress ?? null
  };
}

function clearCompletionTimer(state) {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}

function completeTurn(state, turn = null, options = {}) {
  if (state.completed) {
    return;
  }

  clearCompletionTimer(state);
  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId) {
      state.turnId = turn.id;
    }
  } else if (!state.finalTurn) {
    state.finalTurn = {
      id: state.turnId ?? "inferred-turn",
      status: "completed"
    };
  }

  if (options.inferred) {
    emitProgress(state.onProgress, "Turn completion inferred after the main thread finished and subagent work drained.", "finalizing");
  }

  state.resolveCompletion(state);
}

// Inferred completion is a guarded FALLBACK (Defect A). The primary completion
// signal is always the real main-thread turn/completed. Inference is eligible
// ONLY when the turn actually spawned subagent/collab work that has fully
// drained — plain recon turns never infer; they wait for turn/completed. When
// eligible, arm a quiet timer that re-arms on every subsequent belonging
// item/message (see scheduleInferredCompletion call sites) and fires only after
// inferredCompletionQuietMs of genuine silence with no real turn/completed.
function inferenceEligible(state) {
  return (
    !state.completed &&
    !state.finalTurn &&
    state.sawSubagentWork &&
    state.pendingCollaborations.size === 0 &&
    state.activeSubagentTurns.size === 0
  );
}

function scheduleInferredCompletion(state) {
  if (!inferenceEligible(state)) {
    return;
  }

  clearCompletionTimer(state);
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    if (!inferenceEligible(state)) {
      return;
    }
    completeTurn(state, null, { inferred: true });
  }, state.inferredCompletionQuietMs);
  state.completionTimer.unref?.();
}

function maybeRearmInferredCompletion(state) {
  if (state.completionTimer && inferenceEligible(state)) {
    scheduleInferredCompletion(state);
  }
}

function belongsToTurn(state, message) {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}

function recordItem(state, item, lifecycle, threadId = null) {
  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === "started" || item.status === "inProgress") {
        state.sawSubagentWork = true;
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === "completed") {
        state.pendingCollaborations.delete(item.id);
        scheduleInferredCompletion(state);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      registerThread(state, receiverThreadId);
    }
  }

  if (item.type === "agentMessage") {
    state.messages.push({
      lifecycle,
      phase: item.phase ?? null,
      text: item.text ?? ""
    });
    if (item.text) {
      if (!threadId || threadId === state.threadId) {
        state.lastAgentMessage = item.text;
        if (lifecycle === "completed" && item.phase === "final_answer") {
          // Bookkeeping only; finalAnswerSeen is no longer part of the inference
          // gate (Defect A) — a readiness cue must not complete a plain turn.
          state.finalAnswerSeen = true;
          // Do NOT infer from a readiness cue on a plain turn. Only re-arm the
          // quiet fallback when subagent work has already happened and drained.
          if (inferenceEligible(state)) {
            scheduleInferredCompletion(state);
          }
        }
      }
      if (lifecycle === "completed") {
        const sourceLabel = labelForThread(state, threadId);
        emitLogEvent(state.onProgress, {
          message: sourceLabel ? `Subagent ${sourceLabel}: ${shorten(item.text, 96)}` : `Assistant message captured: ${shorten(item.text, 96)}`,
          stderrMessage: null,
          phase: item.phase === "final_answer" ? "finalizing" : null,
          logTitle: sourceLabel ? `Subagent ${sourceLabel} message` : "Assistant message",
          logBody: item.text
        });
      }
    }
    return;
  }

  if (item.type === "exitedReviewMode") {
    state.reviewText = item.review ?? "";
    if (lifecycle === "completed" && item.review) {
      emitLogEvent(state.onProgress, {
        message: "Review output captured.",
        stderrMessage: null,
        phase: "finalizing",
        logTitle: "Review output",
        logBody: item.review
      });
    }
    return;
  }

  if (item.type === "reasoning" && lifecycle === "completed") {
    const nextSections = extractReasoningSections(item.summary);
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
    if (nextSections.length > 0) {
      const sourceLabel = labelForThread(state, threadId);
      emitLogEvent(state.onProgress, {
        message: sourceLabel
          ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}`
          : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
        stderrMessage: null,
        logTitle: sourceLabel ? `Subagent ${sourceLabel} reasoning summary` : "Reasoning summary",
        logBody: nextSections.map((section) => `- ${section}`).join("\n")
      });
    }
    return;
  }

  if (item.type === "fileChange" && lifecycle === "completed") {
    state.fileChanges.push(item);
    return;
  }

  if (item.type === "commandExecution" && lifecycle === "completed") {
    state.commandExecutions.push(item);
  }
}

function applyTurnNotification(state, message) {
  switch (message.method) {
    case "thread/started":
      registerThread(state, message.params.thread.id, {
        threadName: message.params.thread.name,
        name: message.params.thread.name,
        agentNickname: message.params.thread.agentNickname,
        agentRole: message.params.thread.agentRole
      });
      break;
    case "thread/name/updated":
      registerThread(state, message.params.threadId, {
        threadName: message.params.threadName ?? null
      });
      break;
    case "turn/started":
      registerThread(state, message.params.threadId);
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.sawSubagentWork = true;
        state.activeSubagentTurns.add(message.params.threadId);
      }
      emitProgress(
        state.onProgress,
        `Turn started (${message.params.turn.id}).`,
        "starting",
        (message.params.threadId ?? null) === state.threadId
          ? {
              threadId: message.params.threadId ?? null,
              turnId: message.params.turn.id ?? null
            }
          : {}
      );
      break;
    case "item/started":
      recordItem(state, message.params.item, "started", message.params.threadId ?? null);
      {
        const update = describeStartedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      maybeRearmInferredCompletion(state);
      break;
    case "item/completed":
      recordItem(state, message.params.item, "completed", message.params.threadId ?? null);
      {
        const update = describeCompletedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      maybeRearmInferredCompletion(state);
      break;
    case "error":
      state.error = message.params.error;
      emitProgress(state.onProgress, `Codex error: ${message.params.error.message}`, "failed");
      break;
    case "turn/completed":
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        scheduleInferredCompletion(state);
        break;
      }
      emitProgress(
        state.onProgress,
        `Turn ${message.params.turn.status === "completed" ? "completed" : message.params.turn.status}.`,
        "finalizing"
      );
      completeTurn(state, message.params.turn);
      break;
    default:
      break;
  }
}

async function captureTurn(client, threadId, startRequest, options = {}) {
  const state = createTurnCaptureState(threadId, options);
  const previousHandler = client.notificationHandler;

  // Idle watchdog: the turn/start RPC and the completion promise only settle on
  // a server response or a full socket close. A half-dead "Reconnecting..."
  // link delivers neither, so without this the turn would hang forever. We
  // reject after `idleTimeoutMs` of total silence, re-arming on every progress
  // notification so a slow-but-active turn is never killed.
  const idleTimeoutMs = Number.isFinite(options.turnIdleTimeoutMs) && options.turnIdleTimeoutMs > 0
    ? options.turnIdleTimeoutMs
    : null;
  let idleTimer = null;
  let idleReject = null;
  let settled = false;
  const idlePromise = idleTimeoutMs
    ? new Promise((_resolve, reject) => { idleReject = reject; })
    : null;
  const armIdle = () => {
    if (!idleTimeoutMs || settled) {
      return;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      const seconds = Math.round(idleTimeoutMs / 1000);
      // Best-effort interrupt so the app-server can release the turn; do NOT
      // await it (the same dead link could make it hang too).
      const interruptTurnId = state.turnId ?? state.pendingTurnId;
      if (interruptTurnId) {
        try {
          client.request("turn/interrupt", { threadId, turnId: interruptTurnId }).catch(() => {});
        } catch {
          // ignore — interrupt is best-effort
        }
      }
      idleReject?.(new Error(`Turn idle for ${seconds}s; aborting (upstream connection appears stalled).`));
    }, idleTimeoutMs);
    idleTimer.unref?.();
  };
  const clearIdle = () => {
    settled = true;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  client.setNotificationHandler((message) => {
    if (!state.turnId) {
      // Buffering window: the turn/start RPC reply has not set state.turnId yet.
      // Capture the turn id from a turn/started for our thread so the idle
      // watchdog can still interrupt (Defect C). Re-arm here — these early
      // notifications are almost always our own.
      armIdle();
      if (message.method === "turn/started" && extractThreadId(message) === state.threadId) {
        state.pendingTurnId = message.params?.turn?.id ?? state.pendingTurnId;
      }
      state.bufferedNotifications.push(message);
      return;
    }

    if (message.method === "thread/started" || message.method === "thread/name/updated") {
      // Turn-agnostic bookkeeping (thread registration / naming). Safe to re-arm.
      armIdle();
      applyTurnNotification(state, message);
      return;
    }

    if (!belongsToTurn(state, message)) {
      // Foreign turn/thread traffic must NOT re-arm our watchdog (Defect B):
      // otherwise cross-turn chatter masks a stuck turn and it never fails fast.
      if (previousHandler) {
        previousHandler(message);
      }
      return;
    }

    // Belongs to our turn: re-arm the idle watchdog, then apply.
    armIdle();
    applyTurnNotification(state, message);
  });

  try {
    armIdle();
    const response = idlePromise
      ? await Promise.race([startRequest(), idlePromise])
      : await startRequest();
    options.onResponse?.(response, state);
    state.turnId = response.turn?.id ?? null;
    if (state.turnId) {
      state.threadTurnIds.set(state.threadId, state.turnId);
    }
    for (const message of state.bufferedNotifications) {
      if (belongsToTurn(state, message)) {
        applyTurnNotification(state, message);
      } else {
        if (previousHandler) {
          previousHandler(message);
        }
      }
    }
    state.bufferedNotifications.length = 0;

    if (response.turn?.status && response.turn.status !== "inProgress") {
      completeTurn(state, response.turn);
    }

    return idlePromise
      ? await Promise.race([state.completion, idlePromise])
      : await state.completion;
  } finally {
    clearIdle();
    clearCompletionTimer(state);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

async function withAppServer(cwd, fn) {
  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd);
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const brokerRequested = client?.transport === "broker" || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    const shouldRetryDirect =
      (client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED"));

    if (client) {
      await client.close().catch(() => {});
      client = null;
    }

    if (!shouldRetryDirect) {
      throw error;
    }

    const directClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

async function withDirectAppServer(cwd, fn) {
  const client = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function resolveCodexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function sourceContentSha256(sourcePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
}

function importedThreadIdForSource(sourcePath) {
  const ledgerPath = path.join(resolveCodexHome(), "external_agent_session_imports.json");
  if (!fs.existsSync(ledgerPath)) {
    return null;
  }
  const ledger = readJsonFile(ledgerPath);
  const canonicalSource = fs.realpathSync(sourcePath);
  const contentSha256 = sourceContentSha256(canonicalSource);
  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  const match = records
    .filter(
      (record) =>
        record?.source_path === canonicalSource &&
        record?.content_sha256 === contentSha256 &&
        typeof record?.imported_thread_id === "string"
    )
    .at(-1);
  return match?.imported_thread_id ?? null;
}

function externalAgentSessionMigration(sourcePath, cwd) {
  return {
    migrationItems: [
      {
        itemType: "SESSIONS",
        description: `Transfer Claude session ${path.basename(sourcePath)}`,
        cwd: null,
        details: {
          plugins: [],
          sessions: [{ path: sourcePath, cwd, title: null }],
          mcpServers: [],
          hooks: [],
          subagents: [],
          commands: []
        }
      }
    ]
  };
}

async function requestExternalAgentSessionImport(client, params) {
  const previousHandler = client.notificationHandler;
  let timeout = null;
  let resolveCompleted;
  let rejectCompleted;
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  void completed.catch(() => {});

  client.setNotificationHandler((message) => {
    if (message.method === EXTERNAL_AGENT_IMPORT_COMPLETED) {
      resolveCompleted();
      return;
    }
    previousHandler?.(message);
  });
  timeout = setTimeout(() => {
    rejectCompleted(new Error("Timed out waiting for Codex to finish importing the Claude session."));
  }, EXTERNAL_AGENT_IMPORT_TIMEOUT_MS);

  try {
    await client.request("externalAgentConfig/import", params);
    await completed;
  } finally {
    clearTimeout(timeout);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

async function startThread(client, cwd, options = {}) {
  const response = await client.request("thread/start", buildThreadParams(cwd, options));
  const threadId = response.thread.id;
  if (options.threadName) {
    try {
      await client.request("thread/name/set", { threadId, name: options.threadName });
    } catch (err) {
      // Only suppress "unknown variant/method" errors from older CLI versions
      // that don't support thread/name/set. Rethrow auth, network, or server errors.
      const msg = String(err?.message ?? err ?? "");
      if (!msg.includes("unknown variant") && !msg.includes("unknown method")) {
        throw err;
      }
    }
  }
  return response;
}

async function resumeThread(client, threadId, cwd, options = {}) {
  return client.request("thread/resume", buildResumeParams(threadId, cwd, options));
}

function buildResultStatus(turnState) {
  if (turnState.error) {
    return 1;
  }
  return turnState.finalTurn?.status === "completed" ? 0 : 1;
}

// A turn can complete with usable output yet still carry a stale transient
// `error` (e.g. "Reconnecting... 1/5") that buildResultStatus turned into a
// non-zero status. Callers that produced a usable result should report success.
// `usableText` is the per-caller "did we get output" signal: finalMessage for
// tasks, reviewText for native review. buildResultStatus and the runners are
// intentionally left alone so result.status semantics stay stable for the
// adversarial path (which has its own, stricter parsed-verdict compensation).
export function resolveRunExitStatus(result, usableText) {
  const recovered =
    result.turn?.status === "completed" && Boolean(String(usableText ?? "").trim());
  return recovered ? 0 : result.status;
}

const BUILTIN_PROVIDER_LABELS = new Map([
  ["openai", "OpenAI"],
  ["ollama", "Ollama"],
  ["lmstudio", "LM Studio"]
]);

function normalizeProviderId(value) {
  const providerId = typeof value === "string" ? value.trim() : "";
  return providerId || null;
}

function formatProviderLabel(providerId, providerConfig = null) {
  const configuredName = typeof providerConfig?.name === "string" ? providerConfig.name.trim() : "";
  if (configuredName) {
    return configuredName;
  }
  if (!providerId) {
    return "The active provider";
  }
  return BUILTIN_PROVIDER_LABELS.get(providerId) ?? providerId;
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresOpenaiAuth: null,
    provider: null,
    ...fields
  };
}

function resolveProviderConfig(configResponse) {
  const config = configResponse?.config;
  if (!config || typeof config !== "object") {
    return {
      providerId: null,
      providerConfig: null
    };
  }

  const providerId = normalizeProviderId(config.model_provider);
  const providers =
    config.model_providers && typeof config.model_providers === "object" && !Array.isArray(config.model_providers)
      ? config.model_providers
      : null;
  const providerConfig =
    providerId && providers?.[providerId] && typeof providers[providerId] === "object" ? providers[providerId] : null;

  return {
    providerId,
    providerConfig
  };
}

function buildAppServerAuthStatus(accountResponse, configResponse) {
  const account = accountResponse?.account ?? null;
  const requiresOpenaiAuth =
    typeof accountResponse?.requiresOpenaiAuth === "boolean" ? accountResponse.requiresOpenaiAuth : null;
  const { providerId, providerConfig } = resolveProviderConfig(configResponse);
  const providerLabel = formatProviderLabel(providerId, providerConfig);

  if (account?.type === "chatgpt") {
    const email = typeof account.email === "string" && account.email.trim() ? account.email.trim() : null;
    return buildAuthStatus({
      loggedIn: true,
      detail: email ? `ChatGPT login active for ${email}` : "ChatGPT login active",
      source: "app-server",
      authMethod: "chatgpt",
      verified: true,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (account?.type === "apiKey") {
    return buildAuthStatus({
      loggedIn: true,
      detail: "API key configured (unverified)",
      source: "app-server",
      authMethod: "apiKey",
      verified: false,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (requiresOpenaiAuth === false) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `${providerLabel} is configured and does not require OpenAI authentication`,
      source: "app-server",
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  return buildAuthStatus({
    loggedIn: false,
    detail: `${providerLabel} requires OpenAI authentication`,
    source: "app-server",
    requiresOpenaiAuth,
    provider: providerId
  });
}

async function getCodexAuthStatusFromClient(client, cwd) {
  try {
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const configResponse = await client.request("config/read", {
      includeLayers: false,
      cwd
    });

    return buildAppServerAuthStatus(accountResponse, configResponse);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  }
}

export function getCodexAvailability(cwd) {
  const versionStatus = binaryAvailable("codex", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = binaryAvailable("codex", ["app-server", "--help"], { cwd });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`
  };
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared Codex runtime.",
      endpoint
    };
  }

  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared Codex runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}

export async function getCodexAuthStatus(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: null,
      provider: null
    };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      env: options.env,
      reuseExistingBroker: true
    });
    return await getCodexAuthStatusFromClient(client, cwd);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

export async function interruptAppServerTurn(cwd, { threadId, turnId }) {
  if (!threadId || !turnId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing threadId or turnId"
    };
  }

  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: availability.detail
    };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, { reuseExistingBroker: true });
    await client.request("turn/interrupt", { threadId, turnId });
    return {
      attempted: true,
      interrupted: true,
      transport: client.transport,
      detail: `Interrupted ${turnId} on ${threadId}.`
    };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      transport: client?.transport ?? null,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function runAppServerReview(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Starting Codex review thread.", "starting");
    const thread = await startThread(client, cwd, {
      model: options.model,
      sandbox: "read-only",
      ephemeral: true,
      threadName: options.threadName
    });
    const sourceThreadId = thread.thread.id;
    emitProgress(options.onProgress, `Thread ready (${sourceThreadId}).`, "starting", {
      threadId: sourceThreadId
    });
    const delivery = options.delivery ?? "inline";

    const turnState = await captureTurn(
      client,
      sourceThreadId,
      () =>
        client.request("review/start", {
          threadId: sourceThreadId,
          delivery,
          target: options.target
        }),
      {
        onProgress: options.onProgress,
        onResponse(response, state) {
          if (response.reviewThreadId) {
            state.threadIds.add(response.reviewThreadId);
            if (delivery === "detached") {
              state.threadId = response.reviewThreadId;
            }
          }
        }
      }
    );

    return {
      status: buildResultStatus(turnState),
      threadId: turnState.threadId,
      sourceThreadId,
      turnId: turnState.turnId,
      reviewText: turnState.reviewText,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}

export async function importExternalAgentSession(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
  if (!options.sourcePath) {
    throw new Error("A Claude session source path is required.");
  }

  return withDirectAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Importing Claude session into Codex.", "transferring");
    try {
      await requestExternalAgentSessionImport(client, externalAgentSessionMigration(options.sourcePath, cwd));
    } catch (error) {
      if (error?.rpcCode === -32601) {
        throw new Error(
          "This Codex version does not support Claude session transfer. Update Codex with `npm install -g @openai/codex@latest`, then retry.",
          { cause: error }
        );
      }
      throw error;
    }
    const threadId = importedThreadIdForSource(options.sourcePath);
    if (!threadId) {
      const stderr = cleanCodexStderr(client.stderr);
      throw new Error(
        `Codex reported that the Claude import completed, but did not record an imported thread.${stderr ? `\n${stderr}` : " Check the Codex app-server logs for the underlying import error."}`
      );
    }
    emitProgress(options.onProgress, `Claude session imported (${threadId}).`, "completed", { threadId });
    return {
      threadId,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}

export async function runAppServerTurn(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  // Pass-through only: no implicit default. captureTurn arms no watchdog when
  // turnIdleTimeoutMs is absent/invalid. Review callers supply the default via
  // resolveReviewTurnIdleTimeoutMs(); task runs intentionally pass nothing.
  const turnIdleTimeoutMs = options.turnIdleTimeoutMs;
  const inferredCompletionQuietMs = options.inferredCompletionQuietMs;

  return withAppServer(cwd, async (client) => {
    let threadId;

    if (options.resumeThreadId) {
      emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, "starting");
      const response = await resumeThread(client, options.resumeThreadId, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: false
      });
      threadId = response.thread.id;
    } else {
      emitProgress(options.onProgress, "Starting Codex task thread.", "starting");
      const response = await startThread(client, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: options.persistThread ? false : true,
        threadName: options.persistThread ? options.threadName : options.threadName ?? null
      });
      threadId = response.thread.id;
    }

    emitProgress(options.onProgress, `Thread ready (${threadId}).`, "starting", {
      threadId
    });

    const prompt = options.prompt?.trim() || options.defaultPrompt || "";
    if (!prompt) {
      throw new Error("A prompt is required for this Codex run.");
    }

    const turnState = await captureTurn(
      client,
      threadId,
      () =>
        client.request("turn/start", {
          threadId,
          input: buildTurnInput(prompt),
          model: options.model ?? null,
          effort: options.effort ?? null,
          outputSchema: options.outputSchema ?? null
        }),
      { onProgress: options.onProgress, turnIdleTimeoutMs, inferredCompletionQuietMs }
    );

    return {
      status: buildResultStatus(turnState),
      threadId,
      turnId: turnState.turnId,
      finalMessage: turnState.lastAgentMessage,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr),
      fileChanges: turnState.fileChanges,
      touchedFiles: collectTouchedFiles(turnState.fileChanges),
      commandExecutions: turnState.commandExecutions
    };
  });
}

const DEFAULT_MAX_INVESTIGATION_TURNS = 10;
const INVESTIGATION_CONTINUATION_CUE = "Continue your investigation.";

export async function runAppServerInvestigation(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  const investigatePrompt = options.investigatePrompt?.trim();
  const finalizePrompt = options.finalizePrompt?.trim();
  if (!investigatePrompt) {
    throw new Error("runAppServerInvestigation requires investigatePrompt.");
  }
  if (!finalizePrompt) {
    throw new Error("runAppServerInvestigation requires finalizePrompt.");
  }
  const maxInvestigationTurns = Number.isFinite(options.maxInvestigationTurns) && options.maxInvestigationTurns > 0
    ? Math.floor(options.maxInvestigationTurns)
    : DEFAULT_MAX_INVESTIGATION_TURNS;
  // Pass-through only (see runAppServerTurn): the review caller supplies the
  // watchdog default via resolveReviewTurnIdleTimeoutMs().
  const turnIdleTimeoutMs = options.turnIdleTimeoutMs;
  const inferredCompletionQuietMs = options.inferredCompletionQuietMs;
  const sandbox = options.sandbox ?? "read-only";

  return withAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Starting Codex investigation thread.", "starting");
    const startResponse = await startThread(client, cwd, {
      model: options.model,
      sandbox,
      ephemeral: true,
      threadName: null
    });
    const threadId = startResponse.thread.id;
    emitProgress(options.onProgress, `Thread ready (${threadId}).`, "starting", { threadId });

    let turnCount = 0;
    let truncated = false;
    let totalCommandsRun = 0;
    const aggregatedCommandExecutions = [];
    const aggregatedFileChanges = [];

    for (let i = 1; i <= maxInvestigationTurns; i += 1) {
      const promptText = i === 1 ? investigatePrompt : INVESTIGATION_CONTINUATION_CUE;
      emitProgress(options.onProgress, `Investigation turn ${i}.`, "investigating");

      let turnState;
      try {
        turnState = await captureTurn(
          client,
          threadId,
          () =>
            client.request("turn/start", {
              threadId,
              input: buildTurnInput(promptText),
              model: options.model ?? null,
              effort: options.effort ?? null,
              outputSchema: null
            }),
          { onProgress: options.onProgress, turnIdleTimeoutMs, inferredCompletionQuietMs }
        );
      } catch (transportError) {
        return {
          status: 1,
          threadId,
          turnId: null,
          finalMessage: "",
          reasoningSummary: [],
          turn: null,
          error: { message: transportError?.message ?? String(transportError) },
          stderr: cleanCodexStderr(client.stderr),
          fileChanges: aggregatedFileChanges,
          touchedFiles: collectTouchedFiles(aggregatedFileChanges),
          commandExecutions: aggregatedCommandExecutions,
          investigation: { turnCount, truncated: false }
        };
      }

      turnCount = i;
      const turnCommandCount = turnState.commandExecutions.length;
      totalCommandsRun += turnCommandCount;
      for (const cmd of turnState.commandExecutions) {
        aggregatedCommandExecutions.push(cmd);
      }
      for (const change of turnState.fileChanges) {
        aggregatedFileChanges.push(change);
      }

      // The app-server multiplexes transient retry notices (e.g.
      // "Reconnecting... 1/5") onto the same `error` notification channel as
      // fatal turn failures, and the capture state records the last one seen
      // without clearing it. A reconnect that recovers still drives the turn
      // to turn/completed with an agent message, so treating any `error` as a
      // hard abort would skip the schema-enforced finalize turn and hand the
      // raw investigation prose to the JSON parser. Only abort when the turn
      // produced no usable output — i.e. it did not recover.
      const turnHadAgentMessage = Boolean(turnState.lastAgentMessage);
      const turnRecovered = turnHadAgentMessage && turnState.finalTurn?.status === "completed";

      if (turnState.error && !turnRecovered) {
        return {
          status: buildResultStatus(turnState),
          threadId,
          turnId: turnState.turnId,
          finalMessage: turnState.lastAgentMessage,
          reasoningSummary: turnState.reasoningSummary,
          turn: turnState.finalTurn,
          error: turnState.error,
          stderr: cleanCodexStderr(client.stderr),
          fileChanges: aggregatedFileChanges,
          touchedFiles: collectTouchedFiles(aggregatedFileChanges),
          commandExecutions: aggregatedCommandExecutions,
          investigation: { turnCount, truncated: false }
        };
      }

      // Convergence: a turn that produces no commands and emits an agent
      // message is the contract the investigate prompt teaches the model
      // ("a summary message with no further command calls signals readiness").
      // The legacy check required `phase: "final_answer"`, but recon turns
      // run with outputSchema=null so the app-server does not always tag
      // messages with that phase — leading to runaway turns where the model
      // keeps insisting it has converged but the loop refuses to listen.
      const converged = turnCommandCount === 0 && turnHadAgentMessage;
      if (converged) {
        break;
      }

      if (i === maxInvestigationTurns) {
        truncated = true;
      }
    }

    if (totalCommandsRun === 0) {
      truncated = true;
    }

    emitProgress(options.onProgress, "Investigation complete; finalizing structured output.", "finalizing");

    // The finalize turn is supposed to emit only the structured JSON. In
    // practice the model sometimes emits a tool-call stub instead (e.g.
    // {"cmd": "wc -l ..."}) — if any commands ran during finalize, treat
    // that as a contract violation and retry once with a sharper prompt.
    const STRICT_FINALIZE_REMINDER =
      "STRICT FINALIZE: do not run any shell commands. Output ONLY the JSON " +
      "matching the schema, with no prose, no tool calls, and nothing else.\n\n";
    let finalizeState;
    let finalizeAttempts = 0;
    const MAX_FINALIZE_ATTEMPTS = 2;
    while (finalizeAttempts < MAX_FINALIZE_ATTEMPTS) {
      finalizeAttempts += 1;
      const promptText = finalizeAttempts === 1
        ? finalizePrompt
        : STRICT_FINALIZE_REMINDER + finalizePrompt;
      try {
        finalizeState = await captureTurn(
          client,
          threadId,
          () =>
            client.request("turn/start", {
              threadId,
              input: buildTurnInput(promptText),
              model: options.model ?? null,
              effort: options.effort ?? null,
              outputSchema: options.outputSchema ?? null
            }),
          { onProgress: options.onProgress, turnIdleTimeoutMs, inferredCompletionQuietMs }
        );
      } catch (transportError) {
        return {
          status: 1,
          threadId,
          turnId: null,
          finalMessage: "",
          reasoningSummary: [],
          turn: null,
          error: { message: transportError?.message ?? String(transportError) },
          stderr: cleanCodexStderr(client.stderr),
          fileChanges: aggregatedFileChanges,
          touchedFiles: collectTouchedFiles(aggregatedFileChanges),
          commandExecutions: aggregatedCommandExecutions,
          investigation: { turnCount, truncated }
        };
      }

      // If the finalize turn ran commands, the model violated the contract.
      // Retry once with a stricter prompt; if it still fails, accept the
      // (likely-malformed) output and let the parser surface the error.
      if (finalizeState.commandExecutions.length === 0) {
        break;
      }
      if (finalizeAttempts < MAX_FINALIZE_ATTEMPTS) {
        emitProgress(
          options.onProgress,
          "Finalize turn ran commands; retrying with stricter prompt.",
          "finalizing"
        );
        // Aggregate the wasted commands from this (about-to-be-superseded)
        // attempt so the caller still sees what happened. The final attempt's
        // executions are aggregated once after the loop, so only fold in
        // attempts we are leaving behind here — otherwise the last attempt
        // would be counted twice.
        for (const cmd of finalizeState.commandExecutions) {
          aggregatedCommandExecutions.push(cmd);
        }
        for (const change of finalizeState.fileChanges) {
          aggregatedFileChanges.push(change);
        }
      }
    }

    for (const cmd of finalizeState.commandExecutions) {
      aggregatedCommandExecutions.push(cmd);
    }
    for (const change of finalizeState.fileChanges) {
      aggregatedFileChanges.push(change);
    }

    return {
      status: buildResultStatus(finalizeState),
      threadId,
      turnId: finalizeState.turnId,
      finalMessage: finalizeState.lastAgentMessage,
      reasoningSummary: finalizeState.reasoningSummary,
      turn: finalizeState.finalTurn,
      error: finalizeState.error,
      stderr: cleanCodexStderr(client.stderr),
      fileChanges: aggregatedFileChanges,
      touchedFiles: collectTouchedFiles(aggregatedFileChanges),
      commandExecutions: aggregatedCommandExecutions,
      investigation: { turnCount, truncated }
    };
  });
}

export async function findLatestTaskThread(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    const response = await client.request("thread/list", {
      cwd,
      limit: 20,
      sortKey: "updated_at",
      sourceKinds: ["appServer"],
      searchTerm: TASK_THREAD_PREFIX
    });

    return (
      response.data.find((thread) => typeof thread.name === "string" && thread.name.startsWith(TASK_THREAD_PREFIX)) ??
      null
    );
  });
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Codex did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
