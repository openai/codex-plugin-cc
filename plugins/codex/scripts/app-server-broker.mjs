#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
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
  let shuttingDown = false;
  let shutdownPromise = null;
  let serverRef = null;
  const sockets = new Set();

  // Bound each forwarded request so a hung app server cannot pin
  // inFlightRequests forever, which would permanently disarm idle
  // self-shutdown and make the broker unkillable by anything but a signal.
  // Requests resolve at acceptance (streams ride notifications), so the
  // default is generous; <= 0 disables the bound.
  const requestTimeoutRaw = (process.env.CODEX_BROKER_REQUEST_TIMEOUT_MS ?? "").trim();
  const requestTimeoutMs = /^-?\d+$/.test(requestTimeoutRaw)
    ? Math.min(Number(requestTimeoutRaw), 2 ** 31 - 1)
    : 10 * 60 * 1000;

  // Forward a request to the app server while counting it as in-flight, so idle
  // self-shutdown can never fire while real work is running, even if the calling
  // client disconnected mid-request (which clears activeRequestSocket).
  async function forwardAppRequest(method, params) {
    inFlightRequests += 1;
    try {
      const request = appClient.request(method, params);
      if (requestTimeoutMs <= 0) {
        return await request;
      }
      return await Promise.race([
        request,
        new Promise((_, reject) => {
          const timer = setTimeout(() => {
            // The race cannot cancel the underlying request: releasing
            // ownership while it might still execute would let a clientless
            // turn keep running (and route its notifications to a later
            // client). A request unanswered for this long means the app
            // server is wedged, so terminate the whole broker instead —
            // shutdown closes the app-server child with it, and callers
            // respawn a fresh broker on demand.
            reject(new Error(`Shared broker request ${method} timed out after ${requestTimeoutMs}ms; broker shutting down.`));
            setTimeout(() => process.exit(1), 5000).unref(); // backstop if cleanup hangs
            shutdown(serverRef).finally(() => process.exit(1));
          }, requestTimeoutMs);
          timer.unref();
          request.finally(() => clearTimeout(timer)).catch(() => {});
        })
      ]);
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
        // Releasing stream ownership can be the last activity on this broker;
        // without rearming here an abandoned cwd would never become idle.
        scheduleIdleShutdown();
      }
    }
  }

  // Every shutdown path shares one promise: a second caller (e.g. SIGTERM
  // landing during an idle shutdown) awaits the same cleanup instead of
  // returning early and letting its process.exit() abort the first caller's
  // cleanup mid-flight.
  function shutdown(server) {
    if (!shutdownPromise) {
      shuttingDown = true;
      shutdownPromise = performShutdown(server);
    }
    return shutdownPromise;
  }

  async function performShutdown(server) {
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
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    // Remove the broker's own session directory (socket, pid file, log) so a
    // clean exit leaves nothing behind for the reaper to GC. Recursive removal
    // is restricted to directories this plugin provably created: mkdtemp with
    // the cxc- prefix directly under the OS temp dir. A manual invocation
    // pointing --pid-file anywhere else (even a directory that happens to be
    // named cxc-something) keeps its directory; only the broker's own files
    // are unlinked there.
    const sessionDir = pidFile
      ? path.dirname(pidFile)
      : listenTarget.kind === "unix"
        ? path.dirname(listenTarget.path)
        : null;
    try {
      if (sessionDir && isManagedSessionDir(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } else {
        if (pidFile && fs.existsSync(pidFile)) {
          fs.unlinkSync(pidFile);
        }
        if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
          fs.unlinkSync(listenTarget.path);
        }
      }
    } catch {
      // Ignore already-removed files or directories.
    }
  }

  function isManagedSessionDir(dir) {
    try {
      return (
        path.basename(dir).startsWith("cxc-") &&
        fs.realpathSync(path.dirname(dir)) === fs.realpathSync(os.tmpdir())
      );
    } catch {
      return false;
    }
  }

  appClient.setNotificationHandler(routeNotification);

  // Idle self-shutdown: a broker is spawned per working directory and is reused
  // across sessions, so no external actor can safely decide it is done. Instead
  // the broker exits itself once it has had no connections and no in-flight work
  // for CODEX_BROKER_IDLE_MS (default 30 min; <= 0 disables). Callers respawn one
  // on demand, so exiting when idle is safe and stops brokers from accumulating.
  // Strict integer parsing: parseInt would truncate "30m" to 30ms and accept
  // scientific notation, silently inverting an "effectively never" intent into
  // near-instant shutdown. Malformed values fall back to the default, and the
  // value is clamped below Node's 2^31-1 setTimeout ceiling (beyond it the
  // timer fires after 1ms).
  const idleRaw = (process.env.CODEX_BROKER_IDLE_MS ?? "").trim();
  const idleTimeoutMs = /^-?\d+$/.test(idleRaw)
    ? Math.min(Number(idleRaw), 2 ** 31 - 1)
    : 30 * 60 * 1000;
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
    if (shuttingDown) {
      // A connection that lands between shutdown starting and server.close()
      // taking effect would otherwise hold the close (and the process exit)
      // open until the client goes away on its own.
      socket.destroy();
      return;
    }
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
          // A socket that disconnected during the await already had its
          // ownership cleared by the close handler; assigning it here would
          // strand a dead socket in activeStreamSocket, busy-rejecting other
          // clients and keeping isIdle() false with no event left to clear it.
          if (isStreaming && !socket.destroyed) {
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

  serverRef = server;

  // If the codex app-server child exits or its connection is lost, this broker
  // can never serve another request, but its socket keeps accepting: endpoint
  // probes pass, the reaper skips the live pid, and nothing external kills
  // brokers anymore. Exit instead; callers respawn a fresh broker on demand.
  Promise.resolve(appClient.exitPromise)
    .catch(() => {})
    .then(() => {
      if (!shuttingDown) {
        shutdown(server).finally(() => process.exit(1));
      }
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
