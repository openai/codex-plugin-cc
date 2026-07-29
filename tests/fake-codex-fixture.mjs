import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { makeTempDir, writeExecutable } from "./helpers.mjs";

export function installFakeCodex(binDir, behavior = "review-ok") {
  const statePath = path.join(binDir, "fake-codex-state.json");
  const scriptPath = path.join(binDir, "codex");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const readline = require("node:readline");

	const STATE_PATH = ${JSON.stringify(statePath)};
	const BEHAVIOR = ${JSON.stringify(behavior)};
	const interruptibleTurns = new Map();
	let serializedBusyThread = null;

	function loadState() {
	  if (!fs.existsSync(STATE_PATH)) {
	    return { nextThreadId: 1, nextTurnId: 1, appServerStarts: 0, threads: [], capabilities: null, lastInterrupt: null };
	  }
	  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
	}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function requiresExperimental(field, message, state) {
  if (!(field in (message.params || {}))) {
    return false;
  }
  return !state.capabilities || state.capabilities.experimentalApi !== true;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function buildThread(thread) {
  return {
    id: thread.id,
    preview: thread.preview || "",
    ephemeral: Boolean(thread.ephemeral),
    modelProvider: "openai",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: { type: "idle" },
    path: null,
    cwd: thread.cwd,
    cliVersion: "fake-codex",
    source: "appServer",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: thread.name || null,
    turns: []
  };
}

function buildTurn(id, status = "inProgress", error = null) {
  return { id, status, items: [], error };
}

function buildAccountReadResult() {
  switch (BEHAVIOR) {
    case "logged-out":
    case "refreshable-auth":
    case "auth-run-fails":
      return { account: null, requiresOpenaiAuth: true };
    case "provider-no-auth":
    case "env-key-provider":
      return { account: null, requiresOpenaiAuth: false };
    case "api-key-account-only":
      return { account: { type: "apiKey" }, requiresOpenaiAuth: true };
    default:
      return {
        account: { type: "chatgpt", email: "test@example.com", planType: "plus" },
        requiresOpenaiAuth: true
      };
  }
}

function buildConfigReadResult() {
  switch (BEHAVIOR) {
    case "provider-no-auth":
      return {
        config: { model_provider: "ollama" },
        origins: {}
      };
    case "env-key-provider":
      return {
        config: {
          model_provider: "openai-custom",
          model_providers: {
            "openai-custom": {
              name: "OpenAI custom",
              env_key: "OPENAI_API_KEY",
              requires_openai_auth: false
            }
          }
        },
        origins: {}
      };
    default:
      return {
        config: { model_provider: "openai" },
        origins: {}
      };
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function nextThread(state, cwd, ephemeral) {
  const thread = {
    id: "thr_" + state.nextThreadId++,
    cwd: cwd || process.cwd(),
    name: null,
    preview: "",
    ephemeral: Boolean(ephemeral),
    createdAt: now(),
    updatedAt: now()
  };
  state.threads.unshift(thread);
  saveState(state);
  return thread;
}

function ensureThread(state, threadId) {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) {
    throw new Error("unknown thread " + threadId);
  }
  return thread;
}

function nextTurnId(state) {
  const turnId = "turn_" + state.nextTurnId++;
  saveState(state);
  return turnId;
}

function importLedgerPath() {
  return path.join(process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"), "external_agent_session_imports.json");
}

function loadImportLedger() {
  const ledgerPath = importLedgerPath();
  return fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : { records: [] };
}

function saveImportLedger(ledger) {
  const ledgerPath = importLedgerPath();
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

function emitTurnCompleted(threadId, turnId, item) {
  const items = Array.isArray(item) ? item : [item];
  send({ method: "turn/started", params: { threadId, turn: buildTurn(turnId) } });
  for (const entry of items) {
    if (entry && entry.started) {
      send({ method: "item/started", params: { threadId, turnId, item: entry.started } });
    }
    if (entry && entry.completed) {
      send({ method: "item/completed", params: { threadId, turnId, item: entry.completed } });
    }
  }
  send({ method: "turn/completed", params: { threadId, turn: buildTurn(turnId, "completed") } });
}

function emitTurnCompletedLater(threadId, turnId, item, delayMs) {
  setTimeout(() => {
    emitTurnCompleted(threadId, turnId, item);
  }, delayMs);
}

function nativeReviewText(target) {
  if (target.type === "baseBranch") {
    return "Reviewed changes against " + target.branch + ".\\nNo material issues found.";
  }
  if (target.type === "custom") {
    return "Reviewed custom target.\\nNo material issues found.";
  }
  return "Reviewed uncommitted changes.\\nNo material issues found.";
}

function structuredReviewPayload(prompt) {
  if (prompt.includes("adversarial software review")) {
    if (BEHAVIOR === "adversarial-clean") {
      return JSON.stringify({
        verdict: "approve",
        summary: "No material issues found.",
        findings: [],
        next_steps: []
      });
    }

    return JSON.stringify({
      verdict: "needs-attention",
      summary: "One adversarial concern surfaced.",
      findings: [
        {
          severity: "high",
          title: "Missing empty-state guard",
          body: "The change assumes data is always present.",
          file: "src/app.js",
          line_start: 4,
          line_end: 6,
          confidence: 0.87,
          recommendation: "Handle empty collections before indexing."
        }
      ],
      next_steps: ["Add an empty-state test."]
    });
  }

  if (BEHAVIOR === "invalid-json") {
    return "not valid json";
  }

  return JSON.stringify({
    verdict: "approve",
    summary: "No material issues found.",
    findings: [],
    next_steps: []
  });
}

function taskPayload(prompt, resume) {
  if (prompt.includes("<task>") && prompt.includes("Only review the work from the previous Claude turn.")) {
    if (BEHAVIOR === "adversarial-clean" || BEHAVIOR === "gate-recovered") {
      return "ALLOW: No blocking issues found in the previous turn.";
    }
    return "BLOCK: Missing empty-state guard in src/app.js:4-6.";
  }

  if (resume || prompt.includes("Continue from the current thread state") || prompt.includes("follow up")) {
    return "Resumed the prior run.\\nFollow-up prompt accepted.";
  }

  return "Handled the requested task.\\nTask prompt accepted.";
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli test");
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "--help") {
  console.log("fake app-server help");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  if (BEHAVIOR === "logged-out" || BEHAVIOR === "refreshable-auth" || BEHAVIOR === "auth-run-fails" || BEHAVIOR === "provider-no-auth" || BEHAVIOR === "env-key-provider" || BEHAVIOR === "api-key-account-only") {
    console.error("not authenticated");
    process.exit(1);
  }
  console.log("logged in");
  process.exit(0);
}
if (args[0] === "login") {
  process.exit(0);
}
if (args[0] !== "app-server") {
  process.exit(1);
}
const bootState = loadState();
bootState.appServerStarts = (bootState.appServerStarts || 0) + 1;
saveState(bootState);

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  const state = loadState();

  try {
    switch (message.method) {
      case "initialize":
        state.capabilities = message.params.capabilities || null;
        saveState(state);
        send({ id: message.id, result: { userAgent: "fake-codex-app-server" } });
        break;

      case "initialized":
        break;

      case "account/read":
        send({ id: message.id, result: buildAccountReadResult() });
        break;

      case "config/read":
        if (BEHAVIOR === "config-read-fails") {
          throw new Error("config/read failed for cwd");
        }
        send({ id: message.id, result: buildConfigReadResult() });
        break;

      case "thread/start": {
        if (BEHAVIOR === "auth-run-fails") {
          throw new Error("authentication expired; run codex login");
        }
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/start.persistFullHistory requires experimentalApi capability");
        }
        const thread = nextThread(state, message.params.cwd, message.params.ephemeral);
        send({ id: message.id, result: { thread: buildThread(thread), model: message.params.model || "gpt-5.4", modelProvider: "openai", serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false }, reasoningEffort: null } });
        send({ method: "thread/started", params: { thread: { id: thread.id } } });
        break;
      }

      case "thread/name/set": {
        const thread = ensureThread(state, message.params.threadId);
        thread.name = message.params.name;
        thread.updatedAt = now();
        saveState(state);
        send({ id: message.id, result: {} });
        break;
      }

      case "thread/list": {
        let threads = state.threads.slice();
        if (message.params.cwd) {
          threads = threads.filter((thread) => thread.cwd === message.params.cwd);
        }
        if (message.params.searchTerm) {
          threads = threads.filter((thread) => (thread.name || "").includes(message.params.searchTerm));
        }
        threads.sort((left, right) => right.updatedAt - left.updatedAt);
        send({ id: message.id, result: { data: threads.map(buildThread), nextCursor: null } });
        break;
      }

      case "thread/resume": {
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/resume.persistFullHistory requires experimentalApi capability");
        }
        const thread = ensureThread(state, message.params.threadId);
        thread.updatedAt = now();
        saveState(state);
        send({ id: message.id, result: { thread: buildThread(thread), model: message.params.model || "gpt-5.4", modelProvider: "openai", serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false }, reasoningEffort: null } });
        break;
      }

      case "externalAgentConfig/import": {
        if (BEHAVIOR === "external-import-unsupported") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: externalAgentConfig/import" } });
          break;
        }
        if (BEHAVIOR === "external-import-fails") {
          send({ id: message.id, result: {} });
          send({ method: "externalAgentConfig/import/completed", params: {} });
          break;
        }
        const sessions = (message.params.migrationItems || [])
          .flatMap((item) => item.details && Array.isArray(item.details.sessions) ? item.details.sessions : []);
        const session = sessions[0];
        if (!session) {
          throw new Error("missing external session migration");
        }
        const sourcePath = fs.realpathSync(session.path);
        const contents = fs.readFileSync(sourcePath, "utf8");
        const contentSha256 = crypto.createHash("sha256").update(contents).digest("hex");
        const ledger = loadImportLedger();
        let record = ledger.records.find(
          (candidate) => candidate.source_path === sourcePath && candidate.content_sha256 === contentSha256
        );
        let thread;
        if (record) {
          thread = ensureThread(state, record.imported_thread_id);
        } else {
          const records = contents.split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
          const title = records.find((entry) => entry.type === "custom-title")?.customTitle || null;
          const messages = records
            .filter((entry) => entry.type === "user" || entry.type === "assistant")
            .map((entry) => ({ role: entry.type, text: entry.message?.content || "" }));
          thread = nextThread(state, session.cwd, false);
          thread.name = title;
          thread.preview = messages.find((entry) => entry.role === "user")?.text || "";
          thread.visibleMessages = messages;
          state.lastExternalAgentImport = { sourcePath, threadId: thread.id, messages };
          record = {
            source_path: sourcePath,
            content_sha256: contentSha256,
            imported_thread_id: thread.id,
            imported_at: now(),
            source_modified_at: null
          };
          ledger.records.push(record);
          saveState(state);
          saveImportLedger(ledger);
        }
        send({ id: message.id, result: {} });
        send({ method: "externalAgentConfig/import/completed", params: {} });
        break;
      }

      case "review/start": {
        const thread = ensureThread(state, message.params.threadId);
        let reviewThread = thread;
        if (message.params.delivery === "detached") {
          reviewThread = nextThread(state, thread.cwd, true);
          send({ method: "thread/started", params: { thread: { id: reviewThread.id } } });
        }
        const turnId = nextTurnId(state);
        send({ id: message.id, result: { turn: buildTurn(turnId), reviewThreadId: reviewThread.id } });

        // Queue-driven mode lets a test script the review text and inject a
        // transient (recovered) error to exercise the recovered-status path.
        const reviewEntry =
          BEHAVIOR === "queue-driven" && state.queue && state.queue.length > 0
            ? state.queue.shift()
            : null;
        if (reviewEntry) {
          saveState(state);
        }
        const reviewText = reviewEntry && typeof reviewEntry.reviewText === "string"
          ? reviewEntry.reviewText
          : nativeReviewText(message.params.target);

        send({ method: "turn/started", params: { threadId: reviewThread.id, turn: buildTurn(turnId) } });
        send({
          method: "item/started",
          params: { threadId: reviewThread.id, turnId, item: { type: "enteredReviewMode", id: turnId, review: "current changes" } }
        });
        if (BEHAVIOR === "with-reasoning") {
          send({
            method: "item/completed",
            params: {
              threadId: reviewThread.id,
              turnId,
              item: {
                type: "reasoning",
                id: "reasoning_" + turnId,
                summary: [{ text: "Reviewed the changed files and checked the likely regression paths." }],
                content: []
              }
            }
          });
        }
        send({
          method: "item/completed",
          params: { threadId: reviewThread.id, turnId, item: { type: "exitedReviewMode", id: turnId, review: reviewText } }
        });
        if (reviewEntry && reviewEntry.turnError) {
          send({ method: "error", params: { threadId: reviewThread.id, turnId, error: { message: reviewEntry.turnError.message } } });
        }
        send({ method: "turn/completed", params: { threadId: reviewThread.id, turn: buildTurn(turnId, "completed") } });
        break;
      }

	      case "turn/start": {
	        const thread = ensureThread(state, message.params.threadId);

        if (BEHAVIOR === "queue-driven") {
          if (!state.requests) { state.requests = []; }
          state.requests.push({ method: "turn/start", params: message.params });

          if (state.serialize) {
            if (serializedBusyThread === thread.id) {
              // A turn is already open on this thread. The real app-server queues
              // this turn/start and (in the bug) never opens it: no result, no
              // turn/started, no turn/completed. Persist the recorded request,
              // then hang.
              saveState(state);
              break;
            }
            // Only the normal completion paths below (delayCompletedMs / the
            // synchronous turn/completed) clear serializedBusyThread. Do NOT
            // combine serialize with hang/error entries (cueThenHang,
            // hangNoResponse, hangAfterStarted, foreignChatterThenHang,
            // rpcError) when a SUBSEQUENT queued turn is expected to open — those
            // branches break early and leave the thread marked busy on purpose.
            serializedBusyThread = thread.id;
          }

          const turnId = nextTurnId(state);
          thread.updatedAt = now();

          const entry = (state.queue && state.queue.length > 0) ? state.queue.shift() : null;
          saveState(state);

          if (entry && entry.rpcError) {
            send({ id: message.id, error: { code: -32000, message: entry.rpcError.message } });
            break;
          }

          if (entry && entry.hangNoResponse) {
            // Model a half-dead upstream: the request is received but the
            // server never replies (no result, no turn/started, no
            // turn/completed). The client-side turn/start promise stays
            // pending forever -- this is the real "stuck at turn N" signature.
            break;
          }

          if (entry && entry.hangAfterStarted) {
            // Announce the turn so the client buffers a turn/started carrying the
            // id (populating pendingTurnId), but never send the turn/start RPC
            // result and never complete the turn. Models a delayed RPC reply on a
            // half-dead link, exercising Defect C.
            send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
            break;
          }

          send({ id: message.id, result: { turn: buildTurn(turnId) } });
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });

          if (entry && entry.foreignChatterThenHang) {
            const { count = 5, everyMs = 50 } = entry.foreignChatterThenHang;
            const foreignThreadId = thread.id + "-foreign";
            const foreignTurnId = turnId + "-foreign";
            // Foreign-thread traffic: must NOT re-arm our turn's watchdog.
            for (let n = 0; n < count; n += 1) {
              setTimeout(() => {
                send({
                  method: "item/completed",
                  params: {
                    threadId: foreignThreadId,
                    turnId: foreignTurnId,
                    item: { type: "agentMessage", id: "foreign_" + n, text: "noise", phase: "analysis" }
                  }
                });
              }, everyMs * (n + 1));
            }
            // Never emit turn/completed for OUR turn -> the watchdog must fire.
            break;
          }

          const commands = (entry && entry.commands) || [];
          let cmdCounter = 0;
          for (const cmd of commands) {
            const itemId = "cmd_" + turnId + "_" + (cmdCounter++);
            send({ method: "item/started", params: { threadId: thread.id, turnId, item: { type: "commandExecution", id: itemId, command: cmd.command, status: "in_progress" } } });
            send({ method: "item/completed", params: { threadId: thread.id, turnId, item: { type: "commandExecution", id: itemId, command: cmd.command, exitCode: cmd.exitCode ?? 0, status: "completed" } } });
          }

          if (entry && entry.finalAnswer) {
            const phase = entry.finalAnswer.phase ?? "final_answer";
            send({ method: "item/completed", params: { threadId: thread.id, turnId, item: { type: "agentMessage", id: "msg_" + turnId, text: entry.finalAnswer.text, phase } } });
          }

          if (entry && entry.lateFinalAnswer) {
            const lateTurnId = turnId;
            setTimeout(() => {
              send({ method: "item/completed", params: { threadId: thread.id, turnId: lateTurnId, item: { type: "agentMessage", id: "late_" + lateTurnId, text: entry.lateFinalAnswer.text, phase: "final_answer" } } });
            }, entry.lateFinalAnswer.afterMs ?? 100);
          }

          if (entry && entry.cueThenHang) {
            // Emit only the readiness cue (already sent above); never send a real
            // turn/completed. Exercises the Defect A gate: a plain turn must not
            // infer completion from the cue.
            break;
          }

          if (entry && entry.turnError) {
            send({ method: "error", params: { threadId: thread.id, turnId, error: { message: entry.turnError.message } } });
          }

          if (!entry) {
            send({ method: "item/completed", params: { threadId: thread.id, turnId, item: { type: "agentMessage", id: "msg_" + turnId, text: "", phase: "agent_message" } } });
          }

          if (entry && entry.delayCompletedMs) {
            const completedTurnId = turnId;
            setTimeout(() => {
              if (state.serialize) { serializedBusyThread = null; }
              send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(completedTurnId, "completed") } });
            }, entry.delayCompletedMs);
          } else {
            if (state.serialize) { serializedBusyThread = null; }
            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
          }
          break;
        }

	        const prompt = (message.params.input || [])
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\\n");
        const turnId = nextTurnId(state);
        thread.updatedAt = now();
	        state.lastTurnStart = {
	          threadId: message.params.threadId,
	          turnId,
	          model: message.params.model ?? null,
	          effort: message.params.effort ?? null,
	          prompt
	        };
	        saveState(state);
	        send({ id: message.id, result: { turn: buildTurn(turnId) } });

        const payload = message.params.outputSchema && message.params.outputSchema.properties && message.params.outputSchema.properties.verdict
          ? structuredReviewPayload(prompt)
          : taskPayload(prompt, thread.name && thread.name.startsWith("Codex Companion Task") && prompt.includes("Continue from the current thread state"));

        if (
          BEHAVIOR === "with-subagent" ||
          BEHAVIOR === "with-late-subagent-message" ||
          BEHAVIOR === "with-subagent-no-main-turn-completed"
        ) {
          const subThread = nextThread(state, thread.cwd, true);
          const subThreadRecord = ensureThread(state, subThread.id);
          subThreadRecord.name = "design-challenger";
          saveState(state);
          const subTurnId = nextTurnId(state);

          send({ method: "thread/started", params: { thread: { ...buildThread(subThreadRecord), name: "design-challenger", agentNickname: "design-challenger" } } });
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({
            method: "item/started",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "inProgress",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "inProgress", message: "Investigating design tradeoffs" }
                }
              }
            }
          });
          if (BEHAVIOR === "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          send({ method: "turn/started", params: { threadId: subThread.id, turn: buildTurn(subTurnId) } });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "reasoning",
                id: "reasoning_" + subTurnId,
                summary: [{ text: "Questioned the retry strategy and the cache invalidation boundaries." }],
                content: []
              }
            }
          });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "agentMessage",
                id: "msg_" + subTurnId,
                text: "The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees.",
                phase: "analysis"
              }
            }
          });
          send({ method: "turn/completed", params: { threadId: subThread.id, turn: buildTurn(subTurnId, "completed") } });
          send({
            method: "item/completed",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "completed",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "completed", message: "Finished" }
                }
              }
            }
          });
          if (BEHAVIOR !== "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          if (BEHAVIOR !== "with-subagent-no-main-turn-completed") {
            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
          }
          break;
        }

        const items = [
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Inspected the prompt, gathered evidence, and checked the highest-risk paths first." }],
                    content: []
                  }
              }
            ]
            : []),
          {
            completed: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
          }
        ];

	        if (BEHAVIOR === "interruptible-slow-task") {
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          const timer = setTimeout(() => {
	            if (!interruptibleTurns.has(turnId)) {
	              return;
	            }
	            interruptibleTurns.delete(turnId);
	            for (const entry of items) {
	              if (entry && entry.completed) {
	                send({ method: "item/completed", params: { threadId: thread.id, turnId, item: entry.completed } });
	              }
	            }
	            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
	          }, 5000);
	          interruptibleTurns.set(turnId, { threadId: thread.id, timer });
	        } else if (BEHAVIOR === "slow-task") {
	          emitTurnCompletedLater(thread.id, turnId, items, 400);
	        } else if (BEHAVIOR === "gate-recovered") {
	          // Recovered transient: emit the agent message, then a stale "error"
	          // notice, then turn/completed. The turn still has usable output, so the
	          // companion must exit 0 (resolveRunExitStatus) and the gate must parse
	          // the ALLOW answer rather than block on a phantom failure.
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          for (const entry of items) {
	            if (entry && entry.completed) {
	              send({ method: "item/completed", params: { threadId: thread.id, turnId, item: entry.completed } });
	            }
	          }
	          send({ method: "error", params: { threadId: thread.id, turnId, error: { message: "Reconnecting... 1/5" } } });
	          send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
	        } else {
	          emitTurnCompleted(thread.id, turnId, items);
	        }
	        break;
	      }

	      case "turn/interrupt": {
	        state.lastInterrupt = {
	          threadId: message.params.threadId,
	          turnId: message.params.turnId
	        };
	        saveState(state);
	        const pending = interruptibleTurns.get(message.params.turnId);
	        if (pending) {
	          clearTimeout(pending.timer);
	          interruptibleTurns.delete(message.params.turnId);
	          send({
	            method: "turn/completed",
	            params: {
	              threadId: pending.threadId,
	              turn: buildTurn(message.params.turnId, "interrupted")
	            }
	          });
	        }
	        send({ id: message.id, result: {} });
	        break;
	      }

	      default:
	        send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
        break;
    }
  } catch (error) {
    send({ id: message.id, error: { code: -32000, message: error.message } });
  }
});
`;
  writeExecutable(scriptPath, source);

  // On Windows, npm global binaries are invoked via .cmd wrappers.
  // Create a codex.cmd so the fake binary is discoverable by spawn with shell: true.
  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0codex" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "codex.cmd"), cmdWrapper, { encoding: "utf8" });
  }
}

export function buildEnv(binDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`
  };
}

/**
 * Sets up a queue-driven fake Codex harness for multi-turn tests.
 * Returns a handle with helpers for scripting turn responses and
 * inspecting captured requests.
 */
export function setupFakeCodex({ cwd } = {}) {
  const binDir = makeTempDir("codex-queue-driven-");
  installFakeCodex(binDir, "queue-driven");

  const statePath = path.join(binDir, "fake-codex-state.json");
  const initialState = {
    nextThreadId: 1,
    nextTurnId: 1,
    appServerStarts: 0,
    threads: [],
    capabilities: null,
    lastInterrupt: null,
    queue: [],
    requests: [],
    serialize: false
  };
  fs.writeFileSync(statePath, JSON.stringify(initialState, null, 2));

  const sep = process.platform === "win32" ? ";" : ":";
  process.env.PATH = `${binDir}${sep}${process.env.PATH}`;

  const env = buildEnv(binDir);
  const resolvedCwd = cwd || process.cwd();

  function readState() {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  }

  function writeState(state) {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }

  return {
    cwd: resolvedCwd,
    env,
    binDir,
    queueTurnResponse(entry) {
      const state = readState();
      if (!state.queue) { state.queue = []; }
      state.queue.push(entry);
      writeState(state);
    },
    queueTurnRpcError({ message }) {
      const state = readState();
      if (!state.queue) { state.queue = []; }
      state.queue.push({ rpcError: { message } });
      writeState(state);
    },
    queueTurnHang() {
      // The server receives the turn/start but never responds, modelling a
      // half-dead upstream connection. Used to exercise the idle timeout.
      const state = readState();
      if (!state.queue) { state.queue = []; }
      state.queue.push({ hangNoResponse: true });
      writeState(state);
    },
    queueTurnHangAfterStarted() {
      const state = readState();
      if (!state.queue) { state.queue = []; }
      state.queue.push({ hangAfterStarted: true });
      writeState(state);
    },
    enableSerialization() {
      const state = readState();
      state.serialize = true;
      writeState(state);
    },
    // `requests` re-reads the state file each access; assign to a local variable for repeated use.
    get requests() {
      const state = readState();
      return state.requests ?? [];
    },
    close() {
      const sep = process.platform === "win32" ? ";" : ":";
      process.env.PATH = (process.env.PATH ?? "")
        .split(sep)
        .filter((entry) => entry !== binDir)
        .join(sep);
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  };
}
