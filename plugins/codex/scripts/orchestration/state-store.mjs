
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { ORCHESTRATION_STATE_VERSION, ORCHESTRATION_TERMINAL_STATUSES } from "./constants.mjs";
import { withFileLock } from "./file-lock.mjs";

function workspaceKey(workspaceRoot) {
  const canonical = (() => { try { return fs.realpathSync.native(workspaceRoot); } catch { return path.resolve(workspaceRoot); } })();
  const slug = (path.basename(workspaceRoot) || "workspace").replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${slug}-${crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}
export function resolveOrchestrationWorkspaceDir(cwd, options = {}) {
  const root = options.pluginDataDir ?? process.env.CLAUDE_PLUGIN_DATA;
  const base = root ? path.join(path.resolve(root), "orchestrations") : path.join(os.tmpdir(), "codex-companion", "orchestrations");
  return path.join(base, workspaceKey(resolveWorkspaceRoot(cwd)));
}
function orchDir(cwd, id, options) { return path.join(resolveOrchestrationWorkspaceDir(cwd, options), id); }
function stateFile(cwd, id, options) { return path.join(orchDir(cwd, id, options), "orchestration.json"); }
function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, filePath);
}
export function generateOrchestrationId(now = Date.now()) { return `orch-${now.toString(36)}-${crypto.randomBytes(3).toString("hex")}`; }
export function loadOrchestrationState(cwd, id, options = {}) {
  const file = stateFile(cwd, id, options);
  if (!fs.existsSync(file)) throw new Error(`No orchestration found for "${id}". Run /codex:status.`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
export async function createOrchestrationState(cwd, plan, context = {}, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const id = context.id ?? generateOrchestrationId();
  const now = new Date().toISOString();
  const state = {
    version: ORCHESTRATION_STATE_VERSION, id, workspaceRoot, claudeSessionId: context.claudeSessionId ?? null,
    status: "queued", planRevision: 1, plan, createdAt: now, updatedAt: now, startedAt: null, completedAt: null,
    controller: context.controller ?? null, packages: Object.fromEntries(plan.packages.map((pkg) => [pkg.id, {
      id: pkg.id, status: "planned", attempt: 0, workerId: null, pid: null, threadId: null, turnId: null,
      nativeChildThreadIds: [], nativeSubagentDegraded: false, nativeSubagentDegradationReason: null,
      result: null, error: null, startedAt: null, completedAt: null
    }])), omissions: [], remainingWork: []
  };
  writeAtomic(stateFile(cwd, id, options), state);
  appendOrchestrationEvent(cwd, id, { type: "orchestration-created", message: plan.objective }, options);
  return state;
}
export async function updateOrchestrationState(cwd, id, mutate, options = {}) {
  const directory = orchDir(cwd, id, options);
  return withFileLock(path.join(directory, "state.lock"), {}, async () => {
    const state = loadOrchestrationState(cwd, id, options);
    const result = await mutate(state) ?? state;
    result.updatedAt = new Date().toISOString();
    writeAtomic(stateFile(cwd, id, options), result);
    return result;
  });
}
export function appendOrchestrationEvent(cwd, id, event, options = {}) {
  const file = path.join(orchDir(cwd, id, options), "events.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), orchestrationId: id, packageId: event.packageId ?? null, type: event.type, phase: event.phase ?? null, message: event.message ?? "", data: event.data ?? null })}\n`, { encoding: "utf8", mode: 0o600 });
}
export function writePackageResult(cwd, id, packageId, result, options = {}) {
  const file = path.join(orchDir(cwd, id, options), "results", `${packageId}.json`); writeAtomic(file, result); return file;
}
export function readPackageResult(cwd, id, packageId, options = {}) {
  const file = path.join(orchDir(cwd, id, options), "results", `${packageId}.json`); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}
export function listOrchestrations(cwd, options = {}) {
  const directory = resolveOrchestrationWorkspaceDir(cwd, options);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith("orch-"))
    .map((entry) => { try { return loadOrchestrationState(cwd, entry.name, options); } catch { return null; } }).filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
export function resolveOrchestrationReference(cwd, reference, options = {}) {
  const states = listOrchestrations(cwd, options);
  const exact = states.find((state) => state.id === reference);
  if (exact) return { kind: "orchestration", orchestrationId: exact.id };
  const orchMatches = states.filter((state) => state.id.startsWith(reference));
  if (orchMatches.length === 1) return { kind: "orchestration", orchestrationId: orchMatches[0].id };
  const packageMatches = [];
  for (const state of states) for (const packageId of Object.keys(state.packages)) if (packageId === reference || packageId.startsWith(reference)) packageMatches.push({ kind: "package", orchestrationId: state.id, packageId });
  if (packageMatches.length === 1) return packageMatches[0];
  if (orchMatches.length > 1 || packageMatches.length > 1) throw new Error(`Reference "${reference}" is ambiguous. Run /codex:status.`);
  throw new Error(`No orchestration or package found for "${reference}". Run /codex:status.`);
}
export function isTerminalState(state) { return ORCHESTRATION_TERMINAL_STATUSES.has(state.status); }
