#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { loadOrchestrationConfig } from "./config.mjs";
import { OrchestrationController } from "./controller.mjs";
import { parseControllerEndpoint } from "./ipc.mjs";
import { WorkerPool } from "./worker-pool.mjs";
import { reconcilePhase1ControllerLoss } from "./recovery.mjs";

function args(argv) { const result = {}; for (let i = 0; i < argv.length; i += 2) result[argv[i].replace(/^--/, "")] = argv[i + 1]; return result; }
function send(socket, message) { socket.write(`${JSON.stringify(message)}\n`); }
async function main() {
  if (process.argv[2] !== "serve") throw new Error("controller-server.mjs serve --workspace <path> --endpoint <endpoint> --runtime-file <path>");
  const options = args(process.argv.slice(3)); const workspaceRoot = path.resolve(options.workspace); const endpoint = options.endpoint; const runtimeFile = options["runtime-file"];
  const identity = { instanceId: `controller-${process.pid}-${crypto.randomUUID()}`, pid: process.pid, endpoint, workspaceRoot, startedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(runtimeFile), { recursive: true }); fs.writeFileSync(runtimeFile, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const config = loadOrchestrationConfig(workspaceRoot);
  const pool = new WorkerPool({ workspaceRoot, size: config.workers.workspacePoolSize, globalTopLevelLimit: config.workers.globalTopLevelLimit, globalActiveCodexLimit: config.workers.globalActiveCodexLimit, onEvent: () => {} });
  const controller = new OrchestrationController({ workspaceRoot, config, pool, controllerIdentity: identity });
  await reconcilePhase1ControllerLoss(workspaceRoot, identity);
  const target = parseControllerEndpoint(endpoint); if (target.kind === "unix") { fs.mkdirSync(path.dirname(target.path), { recursive: true }); fs.rmSync(target.path, { force: true }); }
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8"); let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk; const index = buffer.indexOf("\n"); if (index < 0) return;
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); let message;
      try {
        message = JSON.parse(line); let result;
        switch (message.method) {
          case "orchestration/start": result = await controller.start(message.params.plan, message.params.context); break;
          case "orchestration/status": result = controller.status(message.params.reference); break;
          case "orchestration/result": result = controller.result(message.params.reference); break;
          case "orchestration/cancel": result = await controller.cancel(message.params.reference); break;
          case "controller/status": result = { ...identity, pool: pool.getSnapshot(), activeOrchestrationIds: [...controller.activeRuns.keys()] }; break;
          case "controller/shutdown": if (controller.activeRuns.size && !message.params.force) throw new Error("Controller has active orchestrations."); await controller.shutdown(); result = {}; send(socket, { id: message.id, result }); server.close(() => process.exit(0)); return;
          default: throw Object.assign(new Error(`Unknown method: ${message.method}`), { rpcCode: -32601 });
        }
        send(socket, { id: message.id, result });
      } catch (error) { send(socket, { id: message?.id ?? null, error: { code: error.rpcCode ?? -32000, message: error.message } }); }
    });
  });
  const cleanup = async () => { await controller.shutdown().catch(() => {}); fs.rmSync(runtimeFile, { force: true }); if (target.kind === "unix") fs.rmSync(target.path, { force: true }); };
  process.on("SIGTERM", async () => { await cleanup(); process.exit(0); }); process.on("SIGINT", async () => { await cleanup(); process.exit(0); });
  server.listen(target.path);
}
main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exit(1); });
