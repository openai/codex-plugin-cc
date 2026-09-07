import crypto from "node:crypto";
import { runCommand } from "./process.mjs";

const CONTROL_METHODS = new Set(["turn/steer", "turn/interrupt", "broker/status", "broker/answer", "broker/redirect"]);

// The broker owns this state so short-lived control clients cannot steal the event stream.
export class LiveTurnControl {
  constructor(client, notify, inputTimeoutMs = 600000) {
    this.client = client;
    this.notify = notify;
    this.inputTimeoutMs = inputTimeoutMs;
    this.threads = new Map();
    this.requests = new Map();
    this.tail = Promise.resolve();
  }

  state(threadId) {
    if (!this.threads.has(threadId)) {
      this.threads.set(threadId, { threadId, turnId: null, pendingMessages: [], questions: [],
        interrupting: false, partialChanges: [], undeliveredMessages: [], error: null });
    }
    return this.threads.get(threadId);
  }

  handles(method) {
    return CONTROL_METHODS.has(method);
  }

  starting(params) {
    this.state(params.threadId).cwd = params.cwd ?? this.client.cwd;
  }

  request(method, params) {
    if (method === "broker/status") return Promise.resolve(this.snapshot(params.threadId));
    const result = this.tail.then(() => this.execute(method, params));
    this.tail = result.catch(() => {});
    return result;
  }

  snapshot(threadId) {
    const state = this.threads.get(threadId);
    if (!state) throw new Error("Thread is not loaded in this broker.");
    const { redirectInput, interruptedReport, finishInterrupt, ...snapshot } = state;
    return snapshot;
  }

  clearQuestions(state) {
    for (const question of state.questions) {
      clearTimeout(this.requests.get(question.requestId)?.timer);
      this.requests.delete(question.requestId);
    }
    state.questions = [];
  }

  observe(message) {
    const p = message.params ?? {};
    const threadId = p.threadId ?? p.thread?.id;
    if (!threadId) return;
    const state = this.state(threadId);
    if (message.method === "turn/started") {
      this.clearQuestions(state);
      Object.assign(state, { turnId: p.turn.id, pendingMessages: [], partialChanges: [], error: null, interrupting: false });
    } else if (message.method === "item/started" && p.item?.type === "userMessage") {
      state.pendingMessages = state.pendingMessages.filter((item) => item.id !== p.item.clientId);
    } else if (message.method === "item/completed" && p.item?.type === "fileChange") {
      for (const change of p.item.changes ?? []) {
        const previous = state.partialChanges.findIndex((entry) => entry.path === change.path);
        const entry = { path: change.path, status: p.item.status };
        if (previous === -1) state.partialChanges.push(entry);
        else state.partialChanges[previous] = entry;
      }
    } else if (message.method === "serverRequest/resolved") {
      clearTimeout(this.requests.get(p.requestId)?.timer);
      this.requests.delete(p.requestId);
      state.questions = state.questions.filter((question) => question.requestId !== p.requestId);
    } else if (message.method === "turn/completed" && p.turn.id === state.turnId) {
      if (p.turn.status === "interrupted") {
        const status = runCommand("git", ["status", "--short"], { cwd: state.cwd ?? this.client.cwd, maxBuffer: 1024 * 1024 });
        state.workspaceStatus = status.error || status.status !== 0
          ? `Unavailable: ${status.error?.message ?? status.stderr}` : status.stdout;
        state.interruptedReport = { partialChanges: [...state.partialChanges], workspaceStatus: state.workspaceStatus };
        p.interruptedWorkspaceStatus = state.workspaceStatus;
        if (state.redirectInput) p.redirectInput = state.redirectInput;
      }
      if (state.error) p.controlError = state.error;
      delete state.redirectInput;
      state.undeliveredMessages = state.pendingMessages;
      state.pendingMessages = [];
      state.interrupting = false;
      state.turnId = null;
      this.clearQuestions(state);
      state.finishInterrupt?.({ status: p.turn.status, ...state.interruptedReport });
    }
  }

  handleServerRequest(message) {
    if (message.method !== "item/tool/requestUserInput") return false;
    const p = message.params;
    const state = this.state(p.threadId);
    if (state.turnId !== p.turnId) return false;
    const question = { requestId: message.id, ...p, expiresAt: Date.now() + this.inputTimeoutMs };
    state.questions.push(question);
    const timer = setTimeout(() => {
      // Recheck after earlier control requests, including an answer, have completed.
      const expired = this.tail.then(async () => {
        if (!this.requests.has(message.id) || state.turnId !== p.turnId) return;
        state.error = "Waiting for user answer timed out.";
        await this.execute("turn/interrupt", { threadId: p.threadId, turnId: p.turnId });
      });
      this.tail = expired.catch((error) => {
        state.error += ` Interrupt failed: ${error.message}`;
      });
    }, this.inputTimeoutMs);
    timer.unref();
    this.requests.set(message.id, { question, timer });
    this.notify({ method: "companion/question", params: question });
    return true;
  }

  async execute(method, p) {
    const state = this.threads.get(p.threadId);
    if (!state?.turnId) throw new Error("No active turn or pending question in this broker.");
    const expectedTurnId = p.expectedTurnId ?? p.turnId;
    if (state.turnId !== expectedTurnId) throw new Error("Active turn mismatch; refresh status before retrying.");
    if (method === "broker/answer") {
      const entry = this.requests.get(p.requestId);
      if (!entry || entry.question.threadId !== p.threadId || entry.question.turnId !== p.turnId) {
        throw new Error("No matching pending question.");
      }
      const ids = entry.question.questions.map((question) => question.id);
      if (!p.answers || Object.keys(p.answers).length !== ids.length || !ids.every((id) =>
        Array.isArray(p.answers[id]?.answers) && p.answers[id].answers.length > 0 &&
        p.answers[id].answers.every((answer) => typeof answer === "string" && answer.trim()))) {
        throw new Error("Answer every question using its exact question ID and an array of nonempty strings.");
      }
      this.client.respond(p.requestId, { answers: p.answers });
      clearTimeout(entry.timer);
      this.requests.delete(p.requestId);
      state.questions = state.questions.filter((question) => question.requestId !== p.requestId);
      return { answered: true, requestId: p.requestId };
    }
    if (method === "turn/steer" || method === "broker/redirect") {
      if (!Array.isArray(p.input) || !p.input.length || p.input.some((item) => item.type !== "text" || !item.text?.trim())) {
        throw new Error("A nonempty text message is required.");
      }
    }
    if (method === "turn/steer") {
      if (state.questions.length) throw new Error("Answer the pending question with answer, or use message --interrupt.");
      if (state.pendingMessages.length >= 100) throw new Error("Pending message queue is full (100 messages).");
      const id = p.clientUserMessageId ?? crypto.randomUUID();
      if (state.pendingMessages.some((message) => message.id === id)) throw new Error("Message ID is already pending.");
      const entry = { id, input: p.input, status: "sending" };
      state.pendingMessages.push(entry);
      try {
        const result = await this.client.request("turn/steer", { threadId: p.threadId, expectedTurnId,
          clientUserMessageId: id, input: p.input });
        entry.status = "accepted";
        return { ...result, messageId: id };
      } catch (error) {
        state.pendingMessages = state.pendingMessages.filter((message) => message !== entry);
        throw error;
      }
    }
    state.interrupting = true;
    if (method === "broker/redirect") state.redirectInput = p.input;
    const terminal = new Promise((resolve) => { state.finishInterrupt = resolve; });
    try {
      await this.client.request("turn/interrupt", { threadId: p.threadId, turnId: expectedTurnId });
      // Core can acknowledge interrupt before it emits turn/completed.
      const report = await Promise.race([terminal, this.client.exitPromise.then(() => {
        throw new Error("Codex disconnected before interruption completed.");
      })]);
      if (report.status !== "interrupted") throw new Error("Turn ended before it could be interrupted.");
      return { interrupted: true, threadId: p.threadId, turnId: expectedTurnId, ...report,
        note: "Changes are retained. Workspace status includes pre-existing changes and shell edits." };
    } catch (error) {
      delete state.redirectInput;
      throw error;
    } finally {
      delete state.finishInterrupt;
      state.interrupting = false;
    }
  }

  close() {
    for (const state of this.threads.values()) this.clearQuestions(state);
  }
}
