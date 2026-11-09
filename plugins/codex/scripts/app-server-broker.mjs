#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  const sockets = new Set();
  const activeTurns = new Set();
  const pendingCollaborations = new Map();
  const finalAnswered = new Map();
  let pendingRequests = 0;
  let idleTimer = null;
  let shuttingDown = false;
  const configuredIdleMs = Number(process.env.CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS);
  const idleTimeoutMs = Number.isFinite(configuredIdleMs) && configuredIdleMs > 0 ? configuredIdleMs : 60000;

  function updateIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (shuttingDown || sockets.size || pendingRequests || activeTurns.size) return;
    idleTimer = setTimeout(() => {
      shutdown(server).then(() => process.exit(0)).catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
      });
    }, idleTimeoutMs);
  }

  function settleFinalAnswer(turnKey, threadId) {
    if (pendingCollaborations.get(threadId)?.size) return;
    setTimeout(() => {
      if (pendingCollaborations.get(threadId)?.size || !finalAnswered.has(turnKey)) return;
      finalAnswered.delete(turnKey);
      activeTurns.delete(turnKey);
      updateIdleTimer();
    }, 250).unref();
  }

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  function routeNotification(message) {
    // A disconnected caller must not make its running turn eligible for shutdown.
    const turnKey = `${message.params?.threadId}:${message.params?.turn?.id ?? message.params?.turnId}`;
    const threadId = message.params?.threadId;
    if (message.method === "turn/started") {
      activeTurns.add(turnKey);
      pendingCollaborations.delete(threadId);
    }
    if (message.method === "turn/completed") {
      activeTurns.delete(turnKey);
      finalAnswered.delete(turnKey);
      // Collaborations belong to the turn that started them; an interrupted turn may never
      // have seen them complete, and a resumed thread must not inherit them.
      pendingCollaborations.delete(threadId);
    }
    // lib/codex.mjs completes a turn from its final answer when turn/completed never
    // arrives, once the thread's collaborations drain. Mirror that so such a turn does not
    // pin the broker, and an unfinished collaboration is not cut off by idle expiry.
    const item = message.params?.item;
    if (item?.type === "collabAgentToolCall") {
      const pending = pendingCollaborations.get(threadId) ?? new Set();
      if (message.method === "item/started" || item.status === "inProgress") {
        pending.add(item.id);
      } else if (message.method === "item/completed") {
        pending.delete(item.id);
      }
      if (pending.size) {
        pendingCollaborations.set(threadId, pending);
      } else {
        pendingCollaborations.delete(threadId);
      }
      if (message.method === "item/completed") {
        for (const [key, owner] of finalAnswered) {
          if (owner === threadId) settleFinalAnswer(key, owner);
        }
      }
    }
    if (message.method === "item/completed" && item?.type === "agentMessage" && item.phase === "final_answer") {
      finalAnswered.set(turnKey, threadId);
      settleFinalAnswer(turnKey, threadId);
    }
    updateIdleTimer();
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  async function shutdown(server) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(idleTimer);
    // Stop admitting clients before the app-server close, which can take seconds.
    // A client admitted while draining would initialize fine, then fail its first request.
    const closed = new Promise((resolve) => server.close(resolve));
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await closed;
    // A replacement broker's teardown may already have removed these.
    if (listenTarget.kind === "unix") {
      fs.rmSync(listenTarget.path, { force: true });
    }
    if (pidFile) {
      fs.rmSync(pidFile, { force: true });
    }
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    updateIdleTimer();
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        if (!allowInterruptDuringActiveStream) {
          activeRequestSocket = socket;
        }
        pendingRequests += 1;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          // Interrupts share request bookkeeping without taking stream ownership.
          if (allowInterruptDuringActiveStream) {
            continue;
          }
          if (isStreaming) {
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (allowInterruptDuringActiveStream) {
            continue;
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
        } finally {
          pendingRequests -= 1;
          updateIdleTimer();
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      updateIdleTimer();
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      updateIdleTimer();
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path, updateIdleTimer);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
