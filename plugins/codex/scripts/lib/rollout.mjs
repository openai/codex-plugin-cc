import fs from "node:fs";
import path from "node:path";

import { resolveCodexHome } from "./codex.mjs";

// When a turn ends without writing a result back to the job record -- the companion
// returned first, the app-server turn was interrupted, the process died -- `result`
// has nothing to hand back. The assistant messages it *did* produce are already on
// disk though: codex writes every turn to its own rollout transcript under
// $CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<threadId>.jsonl.
// Reading the last assistant message there turns an unrecoverable job into a
// partial answer. This is a read-only recovery path; it never writes to the job.
//
// One transcript can hold many turns -- `--resume-last` reuses a thread, so a
// later job appends to the same file. Recovery must therefore be scoped to the
// job's own turn, or an old job gets handed a newer job's answer, which is worse
// than handing it nothing. The assistant records carry no turn id of their own;
// only `task_started` / `turn_context` / `task_complete` do, as `payload.turn_id`
// (snake case -- the job record spells the same value `turnId`). So the scan
// tracks the turn those markers open and keeps only messages inside the wanted one.

function findRolloutFile(sessionsDir, threadId) {
  const suffix = `-${threadId}.jsonl`;
  const stack = [sessionsDir];

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // sessions dir absent, or a directory we cannot read: not fatal
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name.startsWith("rollout-") && entry.name.endsWith(suffix)) {
        return full;
      }
    }
  }

  return null;
}

function messageText(payload) {
  if (typeof payload?.content === "string") {
    return payload.content;
  }
  if (!Array.isArray(payload?.content)) {
    return "";
  }
  return payload.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

function readTurnResult(filePath, turnId) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  let finished = null; // codex's own final message for the turn, from `task_complete`
  let latest = null; // fallback: the last thing it said before the turn was cut short
  let openTurnId = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue; // a killed turn can leave a half-written final line
    }
    const payload = record?.payload;
    const marker = typeof payload?.turn_id === "string" && payload.turn_id ? payload.turn_id : null;

    if (payload?.type === "task_complete") {
      // Prefer this over the raw scan: it is the same text codex shows a caller that
      // did get a result, already stripped of the citation markup the transcript keeps.
      if (marker === turnId && typeof payload.last_agent_message === "string" && payload.last_agent_message.trim()) {
        finished = payload.last_agent_message;
      }
      openTurnId = null; // the turn is over; later records belong to another one
      continue;
    }

    if (marker) {
      openTurnId = marker;
    }
    if (openTurnId !== turnId) {
      continue; // another job's turn on this same thread
    }
    if (payload?.type !== "message" || payload?.role !== "assistant") {
      continue;
    }
    const text = messageText(payload);
    if (text.trim()) {
      latest = text;
    }
  }

  if (finished) {
    return { text: finished, complete: true };
  }
  return latest ? { text: latest, complete: false } : null;
}

/**
 * What codex recorded for `turnId` on `threadId`, or null when there is no
 * transcript, that turn is not in it, or it holds no assistant text. `complete` is
 * true when the answer came from the turn's own `task_complete` record -- that turn
 * finished, and this is the final message. False means the turn was cut short and
 * the text is the last thing said before it stopped, which may be mid-thought.
 *
 * A missing `turnId` returns null: the turn cannot be identified, and a neighbouring
 * turn's answer is a wrong answer.
 *
 * @param {string} threadId
 * @param {{ turnId?: string | null, sessionsDir?: string, codexHome?: string }} [options]
 * @returns {{ text: string, complete: boolean, file: string } | null}
 */
export function readLastAssistantMessage(threadId, options = {}) {
  const turnId = options.turnId;
  if (typeof threadId !== "string" || threadId.length === 0) {
    return null;
  }
  if (typeof turnId !== "string" || turnId.length === 0) {
    return null;
  }

  const sessionsDir =
    options.sessionsDir ?? path.join(options.codexHome ?? resolveCodexHome(), "sessions");
  const file = findRolloutFile(sessionsDir, threadId);
  if (!file) {
    return null;
  }

  const result = readTurnResult(file, turnId);
  if (!result) {
    return null;
  }

  return { ...result, file };
}
