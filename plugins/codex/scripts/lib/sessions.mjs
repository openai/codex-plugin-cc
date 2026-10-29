import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CodexAppServerClient } from "./app-server.mjs";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_BYTES = 65536;
const runFile = promisify(execFile);
const SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"];

export function connectSessions(cwd) {
  // A separate metadata connection must not claim a running plugin broker or
  // resume a thread owned by Desktop. Only native `codex queue` performs writes.
  return CodexAppServerClient.connect(cwd, {
    disableBroker: true,
    requestTimeoutMs: 15000,
    capabilities: { experimentalApi: true }
  });
}

export async function readPages(rpc, method, params = {}) {
  const data = [];
  const seen = new Set();
  let cursor;
  do {
    const result = await rpc.request(method, { ...params, limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data) || (result.nextCursor != null && (typeof result.nextCursor !== "string" || !result.nextCursor))) {
      throw new Error(`Invalid ${method} page; listing is incomplete.`);
    }
    data.push(...result.data);
    cursor = result.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error(`Repeated ${method} cursor; listing is incomplete.`);
    if (cursor) seen.add(cursor);
  } while (cursor);
  return data;
}

function threadSummary(thread) {
  return {
    id: thread.id,
    title: thread.name || thread.id,
    cwd: thread.cwd,
    model: thread.model,
    reasoningEffort: thread.reasoningEffort
  };
}

export async function listSessions(rpc, { archived = false } = {}) {
  const sections = await readPages(rpc, "threadSection/list");
  // Enumerate every section together: filtering one section at a time could
  // silently miss a thread moved to an already-enumerated section.
  const threads = await readPages(rpc, "thread/list", {
    archived, sourceKinds: SOURCE_KINDS, modelProviders: [],
    useStateDbOnly: true, sortKey: "updated_at", sortDirection: "desc"
  });
  if (new Set(threads.map(thread => thread.id)).size !== threads.length) {
    throw new Error("Threads changed during listing; retry the read.");
  }
  const groups = sections.map(section => ({ id: section.id, name: section.name, threads: [] }));
  groups.push({ id: null, name: "Unsectioned", threads: [] });
  const byId = new Map(groups.map(section => [section.id, section]));
  for (const thread of threads) {
    const id = thread.section?.id ?? null;
    if (!byId.has(id)) {
      const group = { id, name: thread.section.name, threads: [] };
      groups.push(group);
      byId.set(id, group);
    }
    byId.get(id).threads.push({ ...threadSummary(thread), status: thread.status?.type ?? "unknown" });
  }
  return {
    scope: "local", archived, consistency: "best-effort; not an atomic snapshot",
    sectionOrder: "API order; Desktop visual order may differ",
    remoteHosts: "not queried", chatgptConversations: "not included", sections: groups
  };
}

export function normalizeThreadId(threadId) {
  if (!UUID.test(threadId ?? "")) throw new Error("Use an exact thread UUID from sessions; names and latest are not accepted.");
  return threadId.toLowerCase();
}

export function validateMessage(message) {
  if (typeof message !== "string" || !message.trim() || message.includes("\0")) {
    throw new Error("A nonempty message without NUL characters is required on stdin.");
  }
  if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) throw new Error("Message exceeds 64 KiB.");
}

export async function nativeQueue(threadId, message, run = runFile) {
  let stdout;
  try {
    ({ stdout } = await run("codex", ["queue", "--thread", threadId, "--message", message], {
      timeout: 30000, maxBuffer: 65536, shell: false, windowsHide: true
    }));
  } catch {
    // execFile errors can include the entire message in their command/output.
    throw new Error("Native codex queue failed or timed out. Delivery UNKNOWN; inspect the target before retrying. A native Codex executable with queue support is required.");
  }
  const receipt = /^Queued message ([0-9a-f-]+) for thread ([0-9a-f-]+)\.$/i.exec(stdout.trim());
  if (!receipt || !UUID.test(receipt[1]) || receipt[2].toLowerCase() !== threadId) {
    throw new Error("Unverified queue receipt. Delivery UNKNOWN; do not retry automatically.");
  }
  return receipt[1];
}

export async function sendSession(rpc, { threadId, message, execute = false }, queue = nativeQueue) {
  threadId = normalizeThreadId(threadId);
  validateMessage(message);
  const { thread } = await rpc.request("thread/read", { threadId, includeTurns: false });
  if (thread?.id !== threadId) throw new Error("Target identity mismatch; no message sent.");
  const target = threadSummary(thread);
  if (!execute) return { state: "PREVIEW", target, bytes: Buffer.byteLength(message, "utf8") };
  const queuedSubmissionId = await queue(threadId, message);
  return { state: "QUEUED", target, queuedSubmissionId, execution: "not confirmed" };
}

export async function listQueue(rpc, threadId) {
  threadId = normalizeThreadId(threadId);
  const queue = await readPages(rpc, "thread/queue/list", { threadId });
  return {
    threadId,
    queue: queue.map(item => ({ id: item.id, requestId: item.clientUserMessageId ?? null })),
    note: "Queue presence means pending; absence does not prove execution."
  };
}
