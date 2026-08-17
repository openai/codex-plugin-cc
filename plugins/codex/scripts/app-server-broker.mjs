#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import {
  clearBrokerSession,
  loadBrokerSession,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import {
  armTimeout,
  brokerIdleShutdownMs,
  brokerStartupTimeoutMs,
  disarmTimeout
} from "./lib/lifecycle-limits.mjs";
import { terminateProcessTree } from "./lib/process.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);

/** How long each step of a shutdown waits before giving up and going down without it. */
const SHUTDOWN_GRACE_MS = 5000;

/** A deadline that never keeps the event loop alive on its own. */
function grace(ms = SHUTDOWN_GRACE_MS) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

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
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>] [--log-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint", "log-file"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  const logFile = options["log-file"] ? path.resolve(options["log-file"]) : null;
  writePidFile(pidFile);

  // Connecting spawns the app-server, which in turn spawns every configured MCP server. Until the
  // listener below is up there is no idle timer and no parent watching — the spawning client gives
  // up after a couple of seconds and, on the normal path, kills nothing. So bound the startup
  // itself: a wedged connect would otherwise strand this whole tree for good.
  const startupTimeoutMs = brokerStartupTimeoutMs();
  const startupTimer = armTimeout(startupTimeoutMs, () => {
    process.stderr.write(`broker startup exceeded ${startupTimeoutMs}ms; terminating\n`);
    terminateProcessTree(process.pid);
    process.exit(1);
  });

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  const sockets = new Set();
  // Turns whose client left before the stream could be handed over: their notifications go
  // nowhere, and they are interrupted rather than left running for the next client to receive.
  const abandonedThreadIds = new Set();
  // Turns that completed before the request continuation could take ownership of them.
  const completedBeforeHandoff = new Set();
  const idleShutdownMs = brokerIdleShutdownMs();
  let idleTimer = null;
  let shuttingDown = false;
  let shutdownPromise = null;

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  /**
   * Stop a turn whose client left before it could be handed the stream.
   *
   * Leaving it running is not harmless: nobody is reading it, and its notifications would be
   * delivered to whichever client connects next, because routing follows whoever currently owns
   * the broker rather than the turn that produced them.
   */
  async function abandonStream(threadIds) {
    for (const threadId of threadIds) {
      abandonedThreadIds.add(threadId);
      try {
        await appClient.request("turn/interrupt", { threadId });
      } catch {
        // Best effort: the turn may already be finishing on its own.
      }
    }
  }

  function routeNotification(message) {
    const threadId = message.params?.threadId ?? null;

    // An abandoned turn belongs to a client that is gone. Never hand it to whoever is here now.
    if (threadId && abandonedThreadIds.has(threadId)) {
      if (message.method === "turn/completed") {
        abandonedThreadIds.delete(threadId);
        armIdleShutdown();
      }
      return;
    }

    if (message.method === "turn/completed" && !activeStreamSocket) {
      // The response and its completion can arrive in one chunk, so this can land before the
      // request continuation assigns ownership. Remember it, or that continuation would take
      // ownership of a turn that is already over and hold the broker busy until the client leaves.
      if (threadId) {
        completedBeforeHandoff.add(threadId);
      }
    }

    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
        // Releasing ownership can be the moment the broker becomes idle — the client may already
        // have disconnected mid-turn. Nothing else fires afterwards, so if the timer is not armed
        // here it never is.
        armIdleShutdown();
      }
    }
  }

  function isBrokerBusy() {
    return sockets.size > 0 || activeRequestSocket !== null || activeStreamSocket !== null;
  }

  function cancelIdleShutdown() {
    disarmTimeout(idleTimer);
    idleTimer = null;
  }

  // A broker outlives the client that spawned it, so without this it survives a crashed or
  // timed-out SessionEnd hook and keeps its app-server (and every MCP server under it) alive
  // indefinitely. Re-armed whenever the last client disconnects, cancelled when one connects.
  function armIdleShutdown() {
    cancelIdleShutdown();
    // A shutdown already in flight must not be rescheduled behind itself; sockets closing as part
    // of it would otherwise arm a timer for a broker that is on its way out.
    if (shuttingDown || isBrokerBusy()) {
      return;
    }
    idleTimer = armTimeout(idleShutdownMs, async () => {
      idleTimer = null;
      if (isBrokerBusy()) {
        armIdleShutdown();
        return;
      }
      await shutdown(server).catch(() => {});
      process.exit(0);
    });
  }

  async function shutdown(server) {
    // Every entry point — the idle timer, `broker/shutdown`, SIGTERM, SIGINT — can land while
    // another is mid-flight. Run once and let the rest await that same pass.
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = runShutdown(server);
    return shutdownPromise;
  }

  async function runShutdown(server) {
    cancelIdleShutdown();
    // Stop accepting before the first await. Otherwise a client can connect while we are closing
    // the app-server, get a broker that looks alive but has no backend, and hold server.close()
    // open on a socket nobody will serve.
    shuttingDown = true;
    const closed = new Promise((resolve) => server.close(() => resolve()));

    for (const socket of sockets) {
      socket.end();
    }

    // A wedged app-server must not outlive the guard meant to reclaim it: waiting on it forever
    // is exactly how the tree survives.
    let backendClosed = false;
    const settled = () => {
      backendClosed = true;
    };
    await Promise.race([appClient.close().then(settled, settled), grace()]);

    // `end()` only half-closes: a client holding its read side open keeps server.close() pending
    // for as long as it likes, which would hang SIGTERM and broker/shutdown just as surely.
    await Promise.race([closed, grace()]);
    for (const socket of sockets) {
      socket.destroy();
    }

    // Clean up after ourselves. When the idle timer fires there is no session-end hook to run
    // teardown for us, so these would otherwise survive every expiry.
    //
    // The artifacts are ours unconditionally — we were told their paths at startup precisely so
    // that this does not depend on the shared record, which by now may name a broker that
    // superseded us while we sat idle. The record itself is the one thing we must not touch in
    // that case: it belongs to whoever it points at.
    try {
      teardownBrokerSession({ endpoint, pidFile, logFile });
    } catch {
      // Best effort; never let bookkeeping block the shutdown.
    }

    try {
      if (loadBrokerSession(cwd)?.endpoint === endpoint) {
        clearBrokerSession(cwd);
      }
    } catch {
      // Best effort; a record we cannot read is one we must not delete.
    }

    // If the app-server never acknowledged the close, it is still running — and on POSIX the
    // client's own fallback signals only its direct pid, so the MCP servers under it would outlive
    // this broker and defeat the whole point of shutting down. Take the group with us. Done last,
    // after the artifacts and the record are already cleaned up, because this ends us too.
    if (!backendClosed) {
      terminateProcessTree(process.pid);
    }
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
    if (shuttingDown) {
      // Racing a shutdown already in flight: refuse cleanly so the caller falls back to starting
      // its own broker rather than talking to one whose app-server is going away.
      socket.destroy();
      return;
    }
    sockets.add(socket);
    cancelIdleShutdown();
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

        // `null`, a bare number and an array are all valid JSON. Dereferencing them below would
        // throw inside this async listener, which on current Node takes the whole broker down —
        // detached, so nothing tears down its app-server or its session record.
        if (message === null || typeof message !== "object" || Array.isArray(message)) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32600, "Invalid JSON-RPC message: expected an object.")
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

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (isStreaming) {
            const threadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
            const finishedAlready = [...threadIds].some((id) => completedBeforeHandoff.delete(id));
            if (!sockets.has(socket)) {
              // The client left while the turn was starting. Taking ownership on its behalf would
              // hold the broker busy for a socket nobody reads; leaving the turn running would let
              // its notifications reach the next client. Stop it instead.
              await abandonStream(threadIds);
            } else if (!finishedAlready) {
              activeStreamSocket = socket;
              activeStreamThreadIds = threadIds;
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
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
            activeStreamThreadIds = null;
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      armIdleShutdown();
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      armIdleShutdown();
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

  // Startup is over once we are accepting; from here the idle timer takes over. A broker nobody
  // ever connects to must not linger either, so arm it immediately.
  //
  // A listen failure — a stale socket path, a permission problem, an address already in use —
  // must reach main()'s handler rather than surfacing as an unhandled error event, or the process
  // dies with its app-server and MCP servers still running and its session record still on disk.
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenTarget.path, () => {
      server.off("error", reject);
      disarmTimeout(startupTimer);
      armIdleShutdown();
      resolve();
    });
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  // By the time most failures reach here the app-server and its MCP servers are already running.
  // The broker is detached, so exiting alone would leave that tree with no parent and no record —
  // the leak this script is supposed to prevent. Take the group down with us.
  terminateProcessTree(process.pid);
  process.exit(1);
});
