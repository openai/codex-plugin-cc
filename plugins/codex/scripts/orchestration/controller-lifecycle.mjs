import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createControllerEndpoint, parseControllerEndpoint } from "./ipc.mjs";
import { OrchestrationControllerClient } from "./controller-client.mjs";
import { withFileLock } from "./file-lock.mjs";

function key(workspaceRoot) {
  return crypto.createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 16);
}

function runtimeDir(workspaceRoot) {
  return path.join(os.tmpdir(), "codex-orchestration-runtime", key(workspaceRoot));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureControllerServer(workspaceRoot, options = {}) {
  const dir = runtimeDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  const runtimeFile = path.join(dir, "controller.json");
  const lockFile = path.join(dir, "controller.lock");

  return withFileLock(lockFile, {}, async () => {
    const existing = read(runtimeFile);
    if (existing && alive(existing.pid)) {
      try {
        await new OrchestrationControllerClient(existing.endpoint).controllerStatus();
        return existing;
      } catch {}
    }

    fs.rmSync(runtimeFile, { force: true });
    if (existing?.endpoint?.startsWith("unix:")) {
      fs.rmSync(parseControllerEndpoint(existing.endpoint).path, { force: true });
    }

    const endpoint = createControllerEndpoint(key(workspaceRoot));
    const scriptPath = fileURLToPath(new URL("./controller-server.mjs", import.meta.url));
    const child = spawn(
      process.execPath,
      [
        scriptPath,
        "serve",
        "--workspace",
        workspaceRoot,
        "--endpoint",
        endpoint,
        "--runtime-file",
        runtimeFile
      ],
      {
        cwd: workspaceRoot,
        env: options.env ?? process.env,
        detached: true,
        stdio: "ignore",
        windowsHide: true
      }
    );
    child.unref();

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const state = read(runtimeFile);
      if (state) {
        try {
          await new OrchestrationControllerClient(endpoint).controllerStatus();
          return state;
        } catch {}
      }
      await sleep(100);
    }
    throw new Error("Timed out starting the Multi-Codex orchestration controller.");
  });
}
