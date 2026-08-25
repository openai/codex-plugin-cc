
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { withFileLock } from "./file-lock.mjs";

function root(options = {}) {
  const pluginData = options.pluginDataDir ?? process.env.CLAUDE_PLUGIN_DATA;
  return pluginData ? path.join(path.resolve(pluginData), "orchestrations", "_global") : path.join(os.tmpdir(), "codex-companion", "orchestrations", "_global");
}
function registryFile(options) { return path.join(root(options), "workers.json"); }
function lockFile(options) { return path.join(root(options), "workers.lock"); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; } }
function read(options) {
  const file = registryFile(options);
  if (!fs.existsSync(file)) return { leases: [] };
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { leases: [] }; }
}
function write(options, value) {
  const file = registryFile(options); fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); fs.renameSync(temp, file);
}
function prune(registry) { return { leases: (registry.leases ?? []).filter((lease) => alive(lease.pid)) }; }
export async function acquireGlobalWorkerLease(options) {
  return withFileLock(lockFile(options), {}, async () => {
    const registry = prune(read(options));
    const topLevelLimit = options.globalTopLevelLimit ?? 8;
    const activeLimit = options.globalActiveCodexLimit ?? 12;
    const activeCount = registry.leases.reduce((sum, lease) => sum + 1 + (lease.activeNativeChildren ?? 0), 0);
    if (registry.leases.length >= topLevelLimit) throw Object.assign(new Error(`Global Codex worker limit ${topLevelLimit} reached.`), { code: "GLOBAL_WORKER_LIMIT" });
    if (activeCount + 1 > activeLimit) throw Object.assign(new Error(`Global active Codex limit ${activeLimit} reached.`), { code: "ACTIVE_CODEX_LIMIT_EXCEEDED" });
    const lease = {
      id: `worker-${process.pid}-${crypto.randomUUID()}`, pid: process.pid, workspaceKey: options.workspaceKey,
      workerId: options.workerId, packageId: options.packageId, acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(), activeNativeChildren: 0
    };
    registry.leases.push(lease); write(options, registry); return lease;
  });
}
export async function updateGlobalWorkerLease(leaseId, patch, options = {}) {
  return withFileLock(lockFile(options), {}, async () => {
    const registry = prune(read(options));
    const index = registry.leases.findIndex((lease) => lease.id === leaseId);
    if (index === -1) return null;
    const next = { ...registry.leases[index], ...patch, heartbeatAt: new Date().toISOString() };
    const projected = registry.leases.reduce((sum, lease, current) => sum + 1 + (current === index ? next.activeNativeChildren ?? 0 : lease.activeNativeChildren ?? 0), 0);
    if (projected > (options.globalActiveCodexLimit ?? 12)) throw Object.assign(new Error(`Global active Codex limit ${options.globalActiveCodexLimit ?? 12} exceeded.`), { code: "ACTIVE_CODEX_LIMIT_EXCEEDED" });
    registry.leases[index] = next; write(options, registry); return next;
  });
}
export async function releaseGlobalWorkerLease(leaseId, options = {}) {
  return withFileLock(lockFile(options), {}, async () => {
    const registry = prune(read(options)); registry.leases = registry.leases.filter((lease) => lease.id !== leaseId); write(options, registry);
  });
}
export async function readGlobalWorkerRegistry(options = {}) { return prune(read(options)); }
export async function getGlobalActiveCodexCount(options = {}) { return (await readGlobalWorkerRegistry(options)).leases.reduce((sum, lease) => sum + 1 + (lease.activeNativeChildren ?? 0), 0); }
