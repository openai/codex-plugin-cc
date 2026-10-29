#!/usr/bin/env node
import { parseArgs } from "node:util";
import process from "node:process";
import { connectSessions, listSessions, listQueue, sendSession, normalizeThreadId, validateMessage } from "./lib/sessions.mjs";

const HELP = `codex-sessions.mjs sessions [--archived] [--json]
codex-sessions.mjs send --thread UUID [--execute] < message.txt
codex-sessions.mjs queue --thread UUID`;

let rpc;
try {
  const { values, positionals } = parseArgs({
    options: {
      json: { type: "boolean" }, archived: { type: "boolean" }, thread: { type: "string" },
      execute: { type: "boolean" }, help: { type: "boolean" }
    }, allowPositionals: true
  });
  const [command] = positionals;
  if (values.help || !command) {
    console.log(HELP);
  } else {
    const allowed = { sessions: ["json", "archived"], send: ["thread", "execute"], queue: ["thread"] };
    if (!Object.hasOwn(allowed, command) || positionals.length !== 1) throw new Error("Unknown command or extra arguments.");
    for (const key of Object.keys(values)) {
      if (!allowed[command].includes(key)) throw new Error(`--${key} is not supported for ${command}.`);
    }
    if (command !== "sessions") values.thread = normalizeThreadId(values.thread);
    let message = "";
    if (command === "send") {
      if (process.stdin.isTTY) throw new Error("Supply message text on stdin.");
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) {
        message += chunk;
        if (Buffer.byteLength(message, "utf8") > 65536) throw new Error("Message exceeds 64 KiB.");
      }
      validateMessage(message);
    }
    try {
      rpc = await connectSessions(process.cwd());
    } catch {
      throw new Error("Cannot open the local Codex metadata connection. Check Codex installation and experimental API support; no message was sent.");
    }
    let result;
    if (command === "sessions") result = await listSessions(rpc, { archived: values.archived });
    if (command === "send") result = await sendSession(rpc, { threadId: values.thread, message, execute: values.execute });
    if (command === "queue") result = await listQueue(rpc, values.thread);
    if (command === "sessions" && !values.json) {
      console.log("Local Codex sessions. Remote hosts and ChatGPT excluded; API ordering may differ from Desktop.\n");
      for (const section of result.sections) {
        // JSON strings keep untrusted names from injecting terminal control codes.
        console.log(JSON.stringify(section.name));
        for (const thread of section.threads) console.log(`  ${JSON.stringify(thread.title)} [${thread.id}] ${JSON.stringify(thread.cwd)}`);
      }
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (rpc) await rpc.close();
}
