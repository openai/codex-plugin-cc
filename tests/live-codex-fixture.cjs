#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

if (process.argv[2] !== "app-server" || process.argv.includes("--help")) {
  console.log("codex-cli test; app-server");
  process.exit(0);
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const threads = new Map();
let nextTurn = 0;
let pendingQuestion = null;
const emit = (method, params) => send({ method, params });
function complete(thread, text, status = "completed") {
  const turn = { id: thread.turnId, status, items: [], error: null };
  if (text) emit("item/completed", { threadId: thread.id, turnId: turn.id, item: {
    type: "agentMessage", id: `msg-${turn.id}`, text, phase: "final_answer"
  } });
  thread.turnId = null;
  emit("turn/completed", { threadId: thread.id, turn });
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const p = message.params ?? {};
  const reply = (result) => send({ id: message.id, result });
  const thread = threads.get(p.threadId);
  if (!message.method) {
    if (pendingQuestion && message.id === pendingQuestion.id) {
      const question = pendingQuestion;
      pendingQuestion = null;
      emit("serverRequest/resolved", { threadId: question.thread.id, requestId: message.id });
      complete(question.thread, JSON.stringify(message.result ?? message.error));
    }
    return;
  }
  switch (message.method) {
    case "initialize": reply({ userAgent: "live-test" }); break;
    case "initialized": break;
    case "thread/start": {
      const value = { id: `thr-${threads.size + 1}`, cwd: p.cwd, turns: [], sandbox: p.sandbox };
      threads.set(value.id, value);
      reply({ thread: value });
      break;
    }
    case "thread/name/set": reply({}); break;
    // A loaded thread deliberately ignores resume overrides, like a subscribed real thread.
    case "thread/resume": reply({ thread }); break;
    case "turn/start": {
      thread.turnId = `turn-${++nextTurn}`;
      thread.inputs = p.input;
      reply({ turn: { id: thread.turnId, status: "inProgress", items: [], error: null } });
      emit("turn/started", { threadId: thread.id, turn: { id: thread.turnId } });
      const text = p.input.map((item) => item.text).join("\n");
      if (text === "ask") {
        pendingQuestion = { id: "question-1", thread };
        send({ id: "question-1", method: "item/tool/requestUserInput", params: {
          threadId: thread.id, turnId: thread.turnId, itemId: "ask-1", autoResolutionMs: null,
          questions: [{ id: "source", header: "Source", question: "Which source?", options: null }]
        } });
      } else if (text === "approve") {
        pendingQuestion = { id: "approval-1", thread };
        send({ id: "approval-1", method: "item/fileChange/requestApproval", params: {
          threadId: thread.id, turnId: thread.turnId, itemId: "write-approval"
        } });
      } else if (text === "fail-late") {
        emit("item/completed", { threadId: thread.id, turnId: thread.turnId, item: {
          type: "agentMessage", id: "early-final", text: "partial result", phase: "final_answer"
        } });
        setTimeout(() => complete(thread, "", "failed"), 600);
      } else if (text.startsWith("write")) {
        if (p.sandboxPolicy?.type === "workspaceWrite") {
          fs.writeFileSync(path.join(thread.cwd, "written.txt"), text);
          complete(thread, "written");
        } else complete(thread, "read-only", "failed");
      } else if (text.startsWith("hold")) {
        thread.lateChange = text === "hold-late";
        fs.writeFileSync(path.join(thread.cwd, "partial.txt"), "partial");
        emit("item/completed", { threadId: thread.id, turnId: thread.turnId, item: {
          type: "fileChange", id: "patch-1", status: "completed",
          changes: [{ path: path.join(thread.cwd, "partial.txt"), kind: { type: "add" }, diff: "+partial" }]
        } });
      } else complete(thread, text);
      break;
    }
    case "turn/steer": {
      if (!thread?.turnId || p.expectedTurnId !== thread.turnId) {
        send({ id: message.id, error: { code: -32600, message: "expected turn mismatch" } });
        break;
      }
      thread.inputs.push(...p.input);
      reply({ turnId: thread.turnId });
      setTimeout(() => {
        emit("item/started", { threadId: thread.id, turnId: thread.turnId, item: {
          type: "userMessage", id: `user-${p.clientUserMessageId}`, clientId: p.clientUserMessageId, content: p.input
        } });
        if (p.input.some((item) => item.text === "finish")) {
          complete(thread, thread.inputs.map((item) => item.text).join("|"));
        }
      }, 100);
      break;
    }
    case "turn/interrupt":
      reply({});
      setTimeout(() => {
      if (pendingQuestion?.thread === thread) pendingQuestion = null;
      if (thread.lateChange) {
        fs.writeFileSync(path.join(thread.cwd, "late.txt"), "late change");
        emit("item/completed", { threadId: thread.id, turnId: thread.turnId, item: {
          type: "fileChange", id: "late-patch", status: "completed",
          changes: [{ path: path.join(thread.cwd, "late.txt"), kind: { type: "add" }, diff: "+late change" }]
        } });
      }
      complete(thread, "", "interrupted");
      }, 25);
      break;
    default: send({ id: message.id, error: { code: -32601, message: "unsupported method" } });
  }
});
