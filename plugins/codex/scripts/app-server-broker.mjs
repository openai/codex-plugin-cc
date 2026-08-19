#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { clearBrokerSession, loadBrokerSession } from "./lib/broker-lifecycle.mjs";

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
  let inFlightRequests = 0;
  const sockets = new Set();

  // Forward a request to the app server while counting it as in-flight, so idle
  // self-shutdown can never fire while real work is running, even if the calling
  // client disconnected mid-request (which clears activeRequestSocket).
  async function forwardAppRequest(method, params) {
    inFlightRequests += 1;
    try {
      return await appClient.request(method, params);
    } finally {
      inFlightRequests -= 1;
      scheduleIdleShutdown();
    }
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
    // Retire this broker's state record first, while its socket is still the
    // live one for this cwd: no replacement broker can have been spawned yet,
    // so the guarded clear cannot race a newer record, and clients probing
    // from here on fall back to starting a fresh broker instead of connecting
    // to a dying one. Guarded on the endpoint matching, so a record that was
    // already replaced (e.g. this broker was deemed unresponsive) is kept.
    try {
      if (loadBrokerSession(cwd)?.endpoint === endpoint) {
        clearBrokerSession(cwd);
      }
    } catch {
      // Ignore unreadable or already-removed state records.
    }
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    // Remove the broker's own session directory (socket, pid file, log) so a
    // clean exit leaves nothing behind for the reaper to GC.
    const sessionDir = pidFile
      ? path.dirname(pidFile)
      : listenTarget.kind === "unix"
        ? path.dirname(listenTarget.path)
        : null;
    if (sessionDir) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch {
        // Ignore an already-removed directory.
      }
    }
  }

  appClient.setNotificationHandler(routeNotification);

  // Idle self-shutdown: a broker is spawned per working directory and is reused
  // across sessions, so no external actor can safely decide it is done. Instead
  // the broker exits itself once it has had no connections and no in-flight work
  // for CODEX_BROKER_IDLE_MS (default 30 min; <= 0 disables). Callers respawn one
  // on demand, so exiting when idle is safe and stops brokers from accumulating.
  const idleMs = Number.parseInt(process.env.CODEX_BROKER_IDLE_MS ?? "", 10);
  const idleTimeoutMs = Number.isFinite(idleMs) ? idleMs : 30 * 60 * 1000;
  let idleTimer = null;
  function cancelIdleShutdown() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }
  function isIdle() {
    return sockets.size === 0 && inFlightRequests === 0 && !activeRequestSocket && !activeStreamSocket;
  }
  function scheduleIdleShutdown() {
    cancelIdleShutdown();
    if (idleTimeoutMs <= 0 || !isIdle()) {
      return;
    }
    idleTimer = setTimeout(() => {
      if (isIdle()) {
        shutdown(server).finally(() => process.exit(0));
      }
    }, idleTimeoutMs);
    idleTimer.unref(); // never keep the process alive solely to fire this timer
  }

  const server = net.createServer((socket) => {
    cancelIdleShutdown();
    sockets.add(socket);
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

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await forwardAppRequest(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;

        try {
          const result = await forwardAppRequest(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
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
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      scheduleIdleShutdown();
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      scheduleIdleShutdown();
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

  server.listen(listenTarget.path, () => {
    scheduleIdleShutdown(); // exit if nobody ever connects
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
