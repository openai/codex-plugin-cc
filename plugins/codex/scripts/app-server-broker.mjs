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

// Capture the turn returned by a streaming request. Compaction returns no turn
// here; turn/started notifications may still supply one.
function buildStreamTurn(method, params, result) {
  const turnId = result?.turn?.id ?? null;
  const threadId = method === "review/start" ? result?.reviewThreadId ?? params?.threadId : params?.threadId;
  return turnId && threadId ? { threadId, turnId } : null;
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
  let activeStream = null;
  let pendingOrphanInterrupts = 0;
  let shuttingDown = false;
  const sockets = new Set();

  // The broker outlives the companion process that started a turn. Without this,
  // a killed client (e.g. its Claude subagent was stopped) leaves Codex running
  // with nobody listening, so tie the turn's lifetime to the owning connection.
  async function interruptOrphanedTurn(stream) {
    if (!stream.turn || stream.completed || stream.interrupting || shuttingDown) {
      return;
    }
    stream.interrupting = true;
    pendingOrphanInterrupts += 1;
    const turn = stream.turn;
    try {
      await appClient.request("turn/interrupt", turn);
      process.stderr.write(`Interrupted turn ${turn.turnId} on ${turn.threadId}: its client disconnected.\n`);
    } catch (error) {
      // The turn may already have completed; nothing else to clean up.
      process.stderr.write(
        `Could not interrupt turn ${turn.turnId} on ${turn.threadId} after its client disconnected: ${error instanceof Error ? error.message : String(error)}\n`
      );
    } finally {
      pendingOrphanInterrupts -= 1;
      if (activeStream === stream) {
        activeStream = null;
      }
    }
  }

  function clearSocketOwnership(socket) {
    // Keep an in-flight request busy until its response arrives: it may still
    // create a turn after the socket closes.
    if (activeStream?.socket === socket) {
      activeStream.disconnected = true;
      void interruptOrphanedTurn(activeStream);
      if (!activeStream.pending && !activeStream.turn) {
        activeStream = null;
      }
    }
  }

  function routeNotification(message) {
    const stream = activeStream;
    const threadId = message.params?.threadId ?? null;
    const turnId = message.params?.turn?.id ?? null;
    if (stream && message.method === "turn/started" && threadId && turnId && stream.threadIds.has(threadId)) {
      stream.turn = { threadId, turnId };
      if (stream.disconnected) {
        void interruptOrphanedTurn(stream);
      }
    }

    const target = activeRequestSocket ?? stream?.socket;
    if (target) {
      send(target, message);
    }
    if (stream && message.method === "turn/completed") {
      // Notifications can arrive in the same chunk as the start response,
      // before the awaiting request handler has resumed.
      stream.completedTurns.add(`${threadId}:${turnId}`);
      if (
        (stream.turn?.threadId === threadId && stream.turn?.turnId === turnId) ||
        (!stream.turn && stream.method === "thread/compact/start" && stream.threadIds.has(threadId))
      ) {
        stream.completed = true;
        activeStream = null;
      }
    }
  }

  async function shutdown(server) {
    shuttingDown = true;
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
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
          isInterruptRequest(message) && activeStream && activeStream.socket !== socket && !activeRequestSocket;

        if (
          pendingOrphanInterrupts > 0 ||
          (((activeRequestSocket && activeRequestSocket !== socket) || (activeStream && activeStream.socket !== socket)) &&
            !allowInterruptDuringActiveStream)
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
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
        const stream = isStreaming
          ? {
              socket,
              method: message.method,
              threadIds: buildStreamThreadIds(message.method, message.params ?? {}, {}),
              turn: null,
              pending: true,
              disconnected: false,
              completed: false,
              interrupting: false,
              completedTurns: new Set()
            }
          : null;
        if (stream) {
          activeStream = stream;
        }

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (stream) {
            stream.pending = false;
            stream.threadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
            stream.turn = buildStreamTurn(message.method, message.params ?? {}, result) ?? stream.turn;
            if (stream.turn && stream.completedTurns.has(`${stream.turn.threadId}:${stream.turn.turnId}`)) {
              stream.completed = true;
            }
            if (stream.completed) {
              if (activeStream === stream) {
                activeStream = null;
              }
            } else if (stream.disconnected) {
              void interruptOrphanedTurn(stream);
              if (!stream.turn && activeStream === stream) {
                activeStream = null;
              }
            }
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
          if (stream && activeStream === stream) {
            activeStream = null;
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
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

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
