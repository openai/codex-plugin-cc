#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";

const IDLE_TIMEOUT_ENV = "CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS";
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

const REQUEST_THREAD_OWNING_METHODS = new Set([
  "turn/start",
  "review/start",
  "thread/compact/start",
  "thread/resume"
]);

const RESPONSE_THREAD_OWNING_METHODS = new Set([
  "thread/start",
  "thread/resume",
  "thread/fork"
]);

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function parseIdleTimeoutMs(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return DEFAULT_IDLE_TIMEOUT_MS;
  }
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_IDLE_TIMEOUT_MS;
  }
  return parsed;
}

function extractNotificationThreadId(message) {
  const params = message?.params;
  if (!params || typeof params !== "object") {
    return null;
  }
  if (typeof params.threadId === "string" && params.threadId) {
    return params.threadId;
  }
  if (typeof params.thread?.id === "string" && params.thread.id) {
    return params.thread.id;
  }
  return null;
}

function extractParentThreadId(thread) {
  if (!thread || typeof thread !== "object") {
    return null;
  }
  if (typeof thread.parentThreadId === "string" && thread.parentThreadId) {
    return thread.parentThreadId;
  }
  const spawnParentId = thread.source?.subAgent?.thread_spawn?.parent_thread_id;
  if (typeof spawnParentId === "string" && spawnParentId) {
    return spawnParentId;
  }
  return null;
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
    throw new Error(
      "Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>] [--idle-timeout-ms <ms>]"
    );
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint", "idle-timeout-ms"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  const idleTimeoutMs = parseIdleTimeoutMs(options["idle-timeout-ms"] ?? process.env[IDLE_TIMEOUT_ENV]);
  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  const sockets = new Set();
  const threadOwners = new Map();
  const socketThreads = new Map();
  let draining = false;
  let idleTimer = null;
  let shutdownPromise = null;

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function claimThread(threadId, socket) {
    if (typeof threadId !== "string" || !threadId || !sockets.has(socket) || socket.destroyed) {
      return;
    }
    const previousOwner = threadOwners.get(threadId);
    if (previousOwner && previousOwner !== socket) {
      socketThreads.get(previousOwner)?.delete(threadId);
    }
    threadOwners.set(threadId, socket);
    let owned = socketThreads.get(socket);
    if (!owned) {
      owned = new Set();
      socketThreads.set(socket, owned);
    }
    owned.add(threadId);
  }

  function releaseSocket(socket) {
    const owned = socketThreads.get(socket);
    if (owned) {
      for (const threadId of owned) {
        if (threadOwners.get(threadId) === socket) {
          threadOwners.delete(threadId);
        }
      }
      socketThreads.delete(socket);
    }
  }

  function claimRequestThreads(method, params, socket) {
    if (REQUEST_THREAD_OWNING_METHODS.has(method) && typeof params?.threadId === "string" && params.threadId) {
      claimThread(params.threadId, socket);
    }
  }

  function claimResponseThreads(method, result, socket) {
    if (RESPONSE_THREAD_OWNING_METHODS.has(method) && typeof result?.thread?.id === "string" && result.thread.id) {
      claimThread(result.thread.id, socket);
    }
    if (method === "review/start" && typeof result?.reviewThreadId === "string" && result.reviewThreadId) {
      claimThread(result.reviewThreadId, socket);
    }
  }

  function routeNotification(message) {
    if (message.method === "thread/started") {
      const thread = message.params?.thread;
      const threadId = typeof thread?.id === "string" ? thread.id : null;
      const parentThreadId = extractParentThreadId(thread);
      if (threadId && parentThreadId) {
        const parentOwner = threadOwners.get(parentThreadId);
        if (parentOwner) {
          claimThread(threadId, parentOwner);
        }
      }
    } else if (message.method === "item/started" || message.method === "item/completed") {
      const item = message.params?.item;
      if (item?.type === "collabAgentToolCall" && Array.isArray(item.receiverThreadIds)) {
        const parentThreadId =
          (typeof message.params?.threadId === "string" && message.params.threadId) ||
          (typeof item.senderThreadId === "string" && item.senderThreadId) ||
          null;
        const parentOwner = parentThreadId ? threadOwners.get(parentThreadId) : null;
        if (parentOwner) {
          for (const receiverThreadId of item.receiverThreadIds) {
            if (typeof receiverThreadId === "string" && receiverThreadId) {
              claimThread(receiverThreadId, parentOwner);
            }
          }
        }
      }
    }

    const threadId = extractNotificationThreadId(message);
    if (threadId) {
      const owner = threadOwners.get(threadId);
      if (owner && sockets.has(owner) && !owner.destroyed) {
        send(owner, message);
        return;
      }
    }

    for (const socket of sockets) {
      send(socket, message);
    }
  }

  function shutdown(server) {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      clearIdleTimer();
      for (const socket of sockets) {
        socket.end();
      }
      await appClient.close().catch(() => {});
      if (server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
      if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
        try {
          fs.unlinkSync(listenTarget.path);
        } catch {
          // Ignore already-removed socket paths.
        }
      }
      if (pidFile && fs.existsSync(pidFile)) {
        try {
          fs.unlinkSync(pidFile);
        } catch {
          // Ignore already-removed pid files.
        }
      }
    })();
    return shutdownPromise;
  }

  async function shutdownAndExit(code) {
    await shutdown(server);
    process.exit(code);
  }

  function scheduleIdleShutdown() {
    clearIdleTimer();
    if (idleTimeoutMs <= 0 || draining || shutdownPromise || sockets.size > 0) {
      return;
    }
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (sockets.size === 0) {
        void shutdownAndExit(0);
      }
    }, idleTimeoutMs);
  }

  async function requestShutdown(requesterSocket) {
    const hasOtherClients = [...sockets].some((candidate) => candidate !== requesterSocket && !candidate.destroyed);
    if (!hasOtherClients) {
      await shutdownAndExit(0);
      return;
    }

    draining = true;
    clearIdleTimer();
    if (server.listening) {
      server.close();
    }
    requesterSocket.end();
  }

  async function handleClientMessage(socket, message) {
    if (message.id !== undefined && message.method === "initialize") {
      send(socket, {
        id: message.id,
        result: {
          userAgent: "codex-companion-broker"
        }
      });
      return;
    }

    if (message.method === "initialized" && message.id === undefined) {
      return;
    }

    if (message.id !== undefined && message.method === "broker/shutdown") {
      send(socket, { id: message.id, result: {} });
      await requestShutdown(socket);
      return;
    }

    if (message.id === undefined) {
      return;
    }

    const params = message.params ?? {};
    claimRequestThreads(message.method, params, socket);

    try {
      const result = await appClient.request(message.method, params);
      claimResponseThreads(message.method, result, socket);
      send(socket, { id: message.id, result });
    } catch (error) {
      send(socket, {
        id: message.id,
        error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
      });
    }
  }

  function handleSocketClosed(socket) {
    if (!sockets.delete(socket)) {
      return;
    }
    releaseSocket(socket);
    if (sockets.size === 0) {
      if (draining) {
        void shutdownAndExit(0);
      } else {
        scheduleIdleShutdown();
      }
    }
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    clearIdleTimer();
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", (chunk) => {
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

        void handleClientMessage(socket, message);
      }
    });

    socket.on("close", () => {
      handleSocketClosed(socket);
    });

    socket.on("error", () => {
      handleSocketClosed(socket);
    });
  });

  appClient.exitPromise.then(() => {
    if (!shutdownPromise) {
      void shutdownAndExit(1);
    }
  });

  process.on("SIGTERM", () => {
    void shutdownAndExit(0);
  });

  process.on("SIGINT", () => {
    void shutdownAndExit(0);
  });

  server.on("listening", () => {
    if (sockets.size === 0) {
      scheduleIdleShutdown();
    }
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
