import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { terminateProcessTree } from "../lib/process.mjs";
import {
  acquireGlobalWorkerLease,
  releaseGlobalWorkerLease,
  updateGlobalWorkerLease
} from "./global-worker-registry.mjs";

function workspaceKey(value) {
  return crypto.createHash("sha256").update(path.resolve(value)).digest("hex").slice(0, 16);
}

function transientError(error) {
  return ["EPIPE", "ECONNRESET", "ECONNREFUSED", "ENOENT", "CODEX_WORKER_EXIT"].includes(error?.code)
    || error?.transient === true;
}

export class WorkerPool {
  constructor(options) {
    this.workspaceRoot = options.workspaceRoot;
    this.size = options.size;
    this.globalTopLevelLimit = options.globalTopLevelLimit ?? 8;
    this.globalActiveCodexLimit = options.globalActiveCodexLimit ?? 12;
    this.pluginDataDir = options.pluginDataDir;
    this.onEvent = options.onEvent ?? (() => {});
    this.active = new Map();
    this.waiters = [];
    this.availableSlots = this.size;
  }

  async waitForSlot() {
    if (this.availableSlots > 0) {
      this.availableSlots -= 1;
      return;
    }
    await new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  releaseSlot() {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve();
    else this.availableSlots = Math.min(this.size, this.availableSlots + 1);
  }

  async execute(orchestrationId, packageSpec, dependencyResults, options = {}) {
    await this.waitForSlot();
    const workerId = `root-${crypto.randomUUID()}`;
    let lease;
    try {
      lease = await acquireGlobalWorkerLease({
        pluginDataDir: this.pluginDataDir,
        workspaceKey: workspaceKey(this.workspaceRoot),
        workerId,
        packageId: packageSpec.id,
        globalTopLevelLimit: this.globalTopLevelLimit,
        globalActiveCodexLimit: this.globalActiveCodexLimit
      });
    } catch (error) {
      this.releaseSlot();
      throw error;
    }

    const requestFile = path.join(
      os.tmpdir(),
      `codex-orchestration-${process.pid}-${crypto.randomUUID()}.json`
    );
    fs.writeFileSync(
      requestFile,
      JSON.stringify({
        workspaceRoot: this.workspaceRoot,
        orchestrationId,
        packageSpec,
        dependencyResults
      }),
      { encoding: "utf8", mode: 0o600 }
    );

    const script = new URL("./package-worker.mjs", import.meta.url);
    const child = spawn(process.execPath, [fileURLToPath(script), requestFile], {
      cwd: this.workspaceRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    let resolveExit;
    const exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const record = {
      workerId,
      child,
      lease,
      packageId: packageSpec.id,
      settled: false,
      nativeChildren: 0,
      exitPromise
    };
    child.once("exit", () => resolveExit());
    this.active.set(packageSpec.id, record);

    let stderr = "";
    let buffer = "";
    /** @type {Record<string, unknown> | null} */
    let finalPayload = null;
    /** @type {{ message?: string, code?: string, transient?: boolean } | null} */
    let reportedError = null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.type === "progress") {
            const nextChildren = message.event?.activeNativeChildren ?? 0;
            if (nextChildren !== record.nativeChildren) {
              record.nativeChildren = nextChildren;
              updateGlobalWorkerLease(
                lease.id,
                { activeNativeChildren: nextChildren },
                {
                  pluginDataDir: this.pluginDataDir,
                  globalActiveCodexLimit: this.globalActiveCodexLimit
                }
              ).catch((error) => {
                if (error.code === "ACTIVE_CODEX_LIMIT_EXCEEDED") this.cancel(packageSpec.id);
              });
            }
            this.onEvent({
              orchestrationId,
              packageId: packageSpec.id,
              type: "package-progress",
              ...message.event
            });
          } else if (message.type === "result") {
            finalPayload = message.payload;
          } else if (message.type === "error") {
            reportedError = message.error;
          }
        } catch (error) {
          reportedError = {
            message: `Invalid worker JSON: ${error.message}`,
            code: "WORKER_PROTOCOL_ERROR"
          };
        }
      }
    });

    const hardTimeoutMs = Math.max(1000, (options.timeoutMinutes ?? 15) * 60_000);
    const timeout = setTimeout(() => {
      reportedError = {
        message: `Package ${packageSpec.id} exceeded ${options.timeoutMinutes ?? 15} minutes.`,
        code: "PACKAGE_TIMEOUT"
      };
      terminateProcessTree(child.pid ?? Number.NaN);
    }, hardTimeoutMs);
    timeout.unref?.();

    try {
      try {
        await options.onStarted?.({ workerId, pid: child.pid });
      } catch (error) {
        terminateProcessTree(child.pid ?? Number.NaN);
        throw error;
      }

      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      if (code !== 0 || !finalPayload) {
        throw Object.assign(
          new Error(
            reportedError?.message
            ?? stderr.trim()
            ?? `Package worker exited with code ${code}.`
          ),
          {
            code: reportedError?.code ?? "CODEX_WORKER_EXIT",
            transient: reportedError?.transient ?? (reportedError?.code == null)
          }
        );
      }
      return { ...(finalPayload ?? {}), workerId, pid: child.pid };
    } finally {
      clearTimeout(timeout);
      record.settled = true;
      this.active.delete(packageSpec.id);
      fs.rmSync(requestFile, { force: true });
      await releaseGlobalWorkerLease(lease.id, { pluginDataDir: this.pluginDataDir });
      this.releaseSlot();
    }
  }

  async cancel(packageId, options = {}) {
    const record = this.active.get(packageId);
    if (!record) return { attempted: false, interrupted: false };

    record.child.stdin?.write(`${JSON.stringify({ type: "interrupt" })}\n`);
    const settled = await Promise.race([
      record.exitPromise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), options.graceMs ?? 1000))
    ]);
    if (!settled) terminateProcessTree(record.child.pid ?? Number.NaN);
    return { attempted: true, interrupted: settled };
  }

  getSnapshot() {
    return {
      size: this.size,
      active: [...this.active.values()].map((entry) => ({
        packageId: entry.packageId,
        workerId: entry.workerId,
        pid: entry.child.pid,
        nativeChildren: entry.nativeChildren
      })),
      queued: this.waiters.length
    };
  }

  async close() {
    for (const packageId of [...this.active.keys()]) await this.cancel(packageId);
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("Worker pool closed."));
  }
}

export { transientError as isTransientWorkerError };
