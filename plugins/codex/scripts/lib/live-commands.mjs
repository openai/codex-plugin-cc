import fs from "node:fs";
import path from "node:path";
import { BROKER_ENDPOINT_ENV, CodexAppServerClient } from "./app-server.mjs";
import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { buildSingleJobSnapshot } from "./job-control.mjs";

async function withLiveClient(cwd, action, options = {}) {
  const endpoint = process.env[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint;
  if (!endpoint) throw new Error("No live broker found. This task cannot receive messages; do not start another runtime for its thread.");
  const client = await CodexAppServerClient.connect(cwd, { ...options, brokerEndpoint: endpoint });
  try {
    return await action(client);
  } finally {
    await client.close();
  }
}

export async function liveStatus(cwd, job) {
  if (!job.threadId) return null;
  try {
    return await withLiveClient(cwd, (client) => client.request("broker/status", { threadId: job.threadId }), { brokerTimeoutMs: 5000 });
  } catch (error) {
    return { unavailable: error.message };
  }
}

export async function acknowledgeNotifications(cwd, job, ids) {
  return withLiveClient(cwd, (client) => client.request("broker/ack-notifications", { threadId: job.threadId, ids }), { brokerTimeoutMs: 5000 });
}

export async function sendLiveCommand(cwd, reference, command, options, text) {
  if (!reference) throw new Error("Pass an explicit job ID from /codex:status.");
  const { job } = buildSingleJobSnapshot(cwd, reference);
  if (job.jobClass !== "task" || job.status !== "running" || !job.threadId) {
    throw new Error("This command requires a running task with a known thread and turn.");
  }
  return withLiveClient(cwd, async (client) => {
    const params = { threadId: job.threadId, turnId: job.turnId };
    if (command === "answer") {
      if (!options["request-id"] || !options["answers-file"]) throw new Error("answer requires --request-id and --answers-file.");
      const snapshot = await client.request("broker/status", { threadId: job.threadId });
      const question = snapshot.questions.find((item) => String(item.requestId) === options["request-id"]);
      if (!question) throw new Error("No matching pending question. Refresh /codex:status.");
      const answers = JSON.parse(fs.readFileSync(path.resolve(cwd, options["answers-file"]), "utf8"));
      return client.request("broker/answer", { ...params, turnId: question.turnId, requestId: question.requestId, answers });
    }
    if (!text?.trim()) throw new Error("message requires text or --prompt-file.");
    if (!job.turnId) throw new Error("The task is still starting. Refresh /codex:status before sending a message.");
    const input = [{ type: "text", text: text.trim(), text_elements: [] }];
    const result = options.interrupt
      ? await client.request("broker/redirect", { ...params, input })
      : await client.request("turn/steer", { threadId: job.threadId, expectedTurnId: job.turnId, input });
    return { jobId: job.id, ...result };
  });
}
