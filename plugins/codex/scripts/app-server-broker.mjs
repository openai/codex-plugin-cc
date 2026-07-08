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
  // The socket whose request is currently awaiting an upstream response. If that
  // socket disconnects before the response arrives (e.g. its turn watchdog fired
  // on a start that never ACKed), the upstream work is orphaned — see onSocketGone.
  let pendingUpstreamSocket = null;
  const sockets = new Set();

  // Idle self-shutdown: the broker is keyed per-cwd and is only reaped on a
  // later ensureBrokerSession for the SAME cwd. A broker for a cwd that is never
  // revisited (deleted worktree, ended session) would otherwise run forever and
  // accumulate as orphaned processes. Exit after IDLE_MS with no connected
  // clients so the leak self-heals; the companion transparently respawns one on
  // the next task. Env-overridable for long idle gaps.
  const IDLE_MS = Number(process.env.CODEX_COMPANION_BROKER_IDLE_MS) || 1_800_000;
  let idleTimer = null;
  function armIdle() {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(async () => {
      if (sockets.size > 0 || activeRequestSocket || activeStreamSocket) {
        armIdle();
        return;
      }
      await shutdown(server);
      process.exit(0);
    }, IDLE_MS);
    idleTimer.unref?.();
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

  function onSocketGone(socket) {
    sockets.delete(socket);
    // The client that owned in-progress upstream work vanished — either a
    // request still in flight (a start that never returned), or a streaming turn
    // that ACKed but has not reached turn/completed (e.g. the companion crashed
    // or was killed before it could interrupt). That turn is now orphaned and
    // may keep running. The broker is single-flight, so there is no other
    // in-flight work to preserve: tear the broker down (closing the upstream
    // app-server) so the abandoned turn cannot keep mutating the workspace or
    // collide with the next task, which reconnects to a fresh runtime. A turn
    // that reached turn/completed (or was interrupted) has already cleared
    // activeStreamSocket via routeNotification, so a normal close does not
    // trigger this.
    if (socket === pendingUpstreamSocket || socket === activeStreamSocket) {
      pendingUpstreamSocket = null;
      shutdown(server).finally(() => process.exit(0));
      return;
    }
    clearSocketOwnership(socket);
    armIdle();
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
    for (const socket of sockets) {
      socket.end();
    }
    // Stop accepting new connections BEFORE closing the upstream app-server. On
    // an idle self-shutdown a new task may connect at the teardown boundary;
    // closing the listener first means that client is either served by the
    // still-open appClient (during drain) or refused with ECONNREFUSED — which
    // the companion retries into a fresh broker — rather than accepted and then
    // failed against a closed app-server (an error withAppServer does not retry).
    await new Promise((resolve) => server.close(resolve));
    await appClient.close().catch(() => {});
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
    armIdle();
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      armIdle();
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
          pendingUpstreamSocket = socket;
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          } finally {
            if (pendingUpstreamSocket === socket) {
              pendingUpstreamSocket = null;
            }
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;
        pendingUpstreamSocket = socket;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
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
        } finally {
          // The request settled (ACK for a streaming turn, or a terminal result):
          // it is no longer in flight, so the socket closing after this is normal
          // teardown, not an abandoned upstream request.
          if (pendingUpstreamSocket === socket) {
            pendingUpstreamSocket = null;
          }
        }
      }
    });

    socket.on("close", () => onSocketGone(socket));

    socket.on("error", () => onSocketGone(socket));
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
  armIdle();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
