#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);
const SUBSCRIBING_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);
const UNSUBSCRIBE_RETRY_DELAYS_MS = [100, 500, 2000];
// Upper bound on how long a request waits for an in-flight thread/unsubscribe of
// the same thread. A hung cleanup request must not wedge the shared broker.
const UNSUBSCRIBE_WAIT_TIMEOUT_MS = 5000;

// Resolves true once the promise settles, or false if the timeout expires first.
function settleWithin(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise.then(
      () => true,
      () => true
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    })
  ]).finally(() => clearTimeout(timer));
}

function buildSubscriptionThreadIds(method, result) {
  const threadIds = new Set();
  if (SUBSCRIBING_METHODS.has(method) && result?.thread?.id) {
    threadIds.add(result.thread.id);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildProvisionalSubscriptionThreadIds(method, params) {
  const threadIds = new Set();
  if (method === "thread/resume" && params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && params?.threadId) {
    threadIds.add(params.threadId);
  }
  return threadIds;
}

function buildNotificationSubscriptionRelationships(message) {
  const relationships = [];
  const thread = message?.method === "thread/started" ? message.params?.thread : null;
  if (thread?.id && thread?.parentThreadId) {
    relationships.push({ sourceThreadId: thread.parentThreadId, subscribedThreadId: thread.id });
  }

  const item = message?.params?.item;
  if (item?.type === "collabAgentToolCall" && item?.senderThreadId && Array.isArray(item.receiverThreadIds)) {
    for (const threadId of item.receiverThreadIds) {
      if (threadId) {
        relationships.push({ sourceThreadId: item.senderThreadId, subscribedThreadId: threadId });
      }
    }
  }
  return relationships;
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
  // App-server subscriptions belong to the broker's single upstream connection.
  // Mirror downstream ownership so one client cannot release another client's thread.
  const socketThreadIds = new Map();
  const threadSockets = new Map();
  const pendingUnsubscribes = new Map();
  const unsubscribeRetryTimers = new Map();
  // Threads a socket claimed for a request that has not succeeded yet, plus any
  // child threads it inherited through those claims while the request was open.
  const provisionalClaims = new Map();

  function cancelUnsubscribeRetry(threadId) {
    const retry = unsubscribeRetryTimers.get(threadId);
    if (!retry) {
      return;
    }
    clearTimeout(retry.timer);
    unsubscribeRetryTimers.delete(threadId);
  }

  function addThreadOwner(socket, threadId) {
    cancelUnsubscribeRetry(threadId);
    let ownedThreadIds = socketThreadIds.get(socket);
    if (!ownedThreadIds) {
      ownedThreadIds = new Set();
      socketThreadIds.set(socket, ownedThreadIds);
    }
    if (ownedThreadIds.has(threadId)) {
      return false;
    }
    ownedThreadIds.add(threadId);

    let owners = threadSockets.get(threadId);
    if (!owners) {
      owners = new Set();
      threadSockets.set(threadId, owners);
    }
    owners.add(socket);
    return true;
  }

  function removeThreadOwner(socket, threadId) {
    const ownedThreadIds = socketThreadIds.get(socket);
    if (!ownedThreadIds?.delete(threadId)) {
      return false;
    }
    if (ownedThreadIds.size === 0) {
      socketThreadIds.delete(socket);
    }

    const owners = threadSockets.get(threadId);
    owners?.delete(socket);
    if (owners?.size === 0) {
      threadSockets.delete(threadId);
    }
    return true;
  }

  function requestThreadUnsubscribe(threadId) {
    // A request that has already been sent is never reused: the thread may have
    // been reacquired and released again while it was in flight. A request that
    // is still queued behind an earlier one re-checks ownership when it sends, so
    // every release until then can share it instead of growing the chain.
    const previous = pendingUnsubscribes.get(threadId);
    if (previous && !previous.sent) {
      return previous.request;
    }
    const entry = { request: null, sent: false };
    const execute = async () => {
      if (previous) {
        // Wait without a bound. The pending entry must not settle while any
        // earlier upstream unsubscribe for this thread is still outstanding,
        // otherwise a retried claim could slip past a hung cleanup request.
        await previous.request.then(
          () => {},
          () => {}
        );
      }
      if (threadSockets.has(threadId)) {
        return { result: null, error: null, skipped: true };
      }
      entry.sent = true;
      const result = await appClient.request("thread/unsubscribe", { threadId });
      return { result, error: null };
    };
    entry.request = execute().then(
      (outcome) => {
        if (pendingUnsubscribes.get(threadId) === entry) {
          pendingUnsubscribes.delete(threadId);
        }
        return outcome;
      },
      (error) => {
        if (pendingUnsubscribes.get(threadId) === entry) {
          pendingUnsubscribes.delete(threadId);
        }
        process.stderr.write(
          `Failed to unsubscribe Codex thread ${threadId}: ${error instanceof Error ? error.message : String(error)}\n`
        );
        return { result: null, error };
      }
    );
    pendingUnsubscribes.set(threadId, entry);
    return entry.request;
  }

  function scheduleUnsubscribeRetry(threadId, retryIndex) {
    if (
      retryIndex >= UNSUBSCRIBE_RETRY_DELAYS_MS.length ||
      unsubscribeRetryTimers.has(threadId) ||
      threadSockets.has(threadId) ||
      appClient.closed
    ) {
      return;
    }
    const timer = setTimeout(() => {
      unsubscribeRetryTimers.delete(threadId);
      void unsubscribeIfUnowned(threadId, { retryOnFailure: true, retryIndex: retryIndex + 1 });
    }, UNSUBSCRIBE_RETRY_DELAYS_MS[retryIndex]);
    timer.unref?.();
    unsubscribeRetryTimers.set(threadId, { timer, retryIndex });
  }

  async function unsubscribeIfUnowned(threadId, { retryOnFailure = false, retryIndex = 0 } = {}) {
    if (threadSockets.has(threadId) || appClient.closed) {
      cancelUnsubscribeRetry(threadId);
      return null;
    }
    const outcome = await requestThreadUnsubscribe(threadId);
    if (outcome.error && retryOnFailure) {
      scheduleUnsubscribeRetry(threadId, retryIndex);
    } else if (!outcome.error) {
      cancelUnsubscribeRetry(threadId);
    }
    return outcome;
  }

  async function releaseThreadOwners(socket, threadIds = socketThreadIds.get(socket) ?? new Set()) {
    const releasedThreadIds = [];
    for (const threadId of [...threadIds]) {
      if (removeThreadOwner(socket, threadId) && !threadSockets.has(threadId)) {
        releasedThreadIds.push(threadId);
      }
    }
    await Promise.all(
      releasedThreadIds.map((threadId) => unsubscribeIfUnowned(threadId, { retryOnFailure: true }))
    );
  }

  function trackSubscriptionResults(socket, method, result) {
    for (const threadId of buildSubscriptionThreadIds(method, result)) {
      if (socket.destroyed || !sockets.has(socket)) {
        void unsubscribeIfUnowned(threadId, { retryOnFailure: true });
        continue;
      }
      addThreadOwner(socket, threadId);
    }
  }

  function trackNotificationSubscriptions(message) {
    // App-server can auto-subscribe its connection to subagent threads. Attribute
    // each child to the downstream owners of its causal parent, not the client
    // that happens to be active when a delayed notification arrives.
    for (const { sourceThreadId, subscribedThreadId } of buildNotificationSubscriptionRelationships(message)) {
      const sourceOwners = [...(threadSockets.get(sourceThreadId) ?? [])].filter(
        (socket) => !socket.destroyed && sockets.has(socket)
      );
      if (sourceOwners.length === 0) {
        void unsubscribeIfUnowned(subscribedThreadId, { retryOnFailure: true });
        continue;
      }
      if (pendingUnsubscribes.has(subscribedThreadId)) {
        // A cleanup request for this child is still outstanding, so its upstream
        // subscription is going away. Do not hand it to new owners.
        continue;
      }
      for (const socket of sourceOwners) {
        if (addThreadOwner(socket, subscribedThreadId)) {
          // Ownership inherited through a claim that has not succeeded yet is
          // rolled back with that claim. The source may itself be an inherited
          // child, so nested descendants are recorded too.
          const claim = provisionalClaims.get(socket);
          if (claim && (claim.threadIds.has(sourceThreadId) || claim.inheritedThreadIds.has(sourceThreadId))) {
            claim.inheritedThreadIds.add(subscribedThreadId);
          }
        }
      }
    }
  }

  async function handleThreadUnsubscribe(socket, params) {
    const threadId = params?.threadId;
    if (typeof threadId !== "string") {
      return appClient.request("thread/unsubscribe", params ?? {});
    }

    const ownedThreadIds = socketThreadIds.get(socket);
    if (!ownedThreadIds?.has(threadId)) {
      if (threadSockets.has(threadId)) {
        return { status: "notSubscribed" };
      }
      const outcome = await unsubscribeIfUnowned(threadId);
      if (outcome?.error) {
        throw outcome.error;
      }
      return outcome?.result ?? { status: "notSubscribed" };
    }

    removeThreadOwner(socket, threadId);
    if (threadSockets.has(threadId)) {
      return { status: "unsubscribed" };
    }

    const outcome = await unsubscribeIfUnowned(threadId);
    if (outcome?.error) {
      if (!socket.destroyed && sockets.has(socket)) {
        addThreadOwner(socket, threadId);
      } else {
        // The requester is gone, so nobody will retry on its behalf. Fall back
        // to the automatic cleanup path for the now-unowned thread.
        scheduleUnsubscribeRetry(threadId, 0);
      }
      throw outcome.error;
    }
    return outcome?.result ?? { status: "unsubscribed" };
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
    trackNotificationSubscriptions(message);
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
    for (const { timer } of unsubscribeRetryTimers.values()) {
      clearTimeout(timer);
    }
    unsubscribeRetryTimers.clear();
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
    let processing = Promise.resolve();

    async function handleLine(line) {
      if (!line.trim() || socket.destroyed || !sockets.has(socket)) {
        return;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        send(socket, {
          id: null,
          error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
        });
        return;
      }

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
        await shutdown(server);
        process.exit(0);
      }

      if (message.id === undefined) {
        return;
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
        return;
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
        return;
      }

      const isStreaming = STREAMING_METHODS.has(message.method);
      // Claim known thread ids before awaiting app-server. This prevents another
      // client's close handler from unsubscribing a concurrently resumed thread.
      const provisionalThreadIds = buildProvisionalSubscriptionThreadIds(message.method, message.params ?? {});
      const addedProvisionalThreadIds = new Set();
      for (const threadId of provisionalThreadIds) {
        if (addThreadOwner(socket, threadId)) {
          addedProvisionalThreadIds.add(threadId);
        }
      }
      const claim = { threadIds: addedProvisionalThreadIds, inheritedThreadIds: new Set() };
      if (addedProvisionalThreadIds.size > 0) {
        provisionalClaims.set(socket, claim);
      }
      const rollBackClaim = () => {
        if (provisionalClaims.get(socket) === claim) {
          provisionalClaims.delete(socket);
        }
        void releaseThreadOwners(socket, new Set([...claim.threadIds, ...claim.inheritedThreadIds]));
      };
      activeRequestSocket = socket;
      // Let an in-flight unsubscribe for the same thread settle first so it cannot
      // overtake the new subscription, and so an explicit unsubscribe does not
      // queue behind it while this socket holds the busy slot. The wait is
      // bounded: a hung cleanup request must not block this client or keep the
      // broker busy for everyone else. If it expires, fail the request instead of
      // racing or waiting on the outstanding unsubscribe.
      const gatedThreadIds = new Set(provisionalThreadIds);
      if (message.method === "thread/unsubscribe" && typeof message.params?.threadId === "string") {
        gatedThreadIds.add(message.params.threadId);
      }
      const settled = await Promise.all(
        [...gatedThreadIds].map((threadId) => {
          const pending = pendingUnsubscribes.get(threadId);
          return pending ? settleWithin(pending.request, UNSUBSCRIBE_WAIT_TIMEOUT_MS) : true;
        })
      );
      if (settled.includes(false)) {
        send(socket, {
          id: message.id,
          error: buildJsonRpcError(
            -32000,
            "Codex thread is still being released upstream; retry the request shortly."
          )
        });
        if (activeRequestSocket === socket) {
          activeRequestSocket = null;
        }
        rollBackClaim();
        return;
      }

      try {
        const result =
          message.method === "thread/unsubscribe"
            ? await handleThreadUnsubscribe(socket, message.params ?? {})
            : await appClient.request(message.method, message.params ?? {});
        trackSubscriptionResults(socket, message.method, result);
        if (provisionalClaims.get(socket) === claim) {
          provisionalClaims.delete(socket);
        }
        send(socket, { id: message.id, result });
        if (isStreaming && !socket.destroyed && sockets.has(socket)) {
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
        // Release after replying: a hung upstream unsubscribe must not withhold
        // the error or leave the broker busy for other clients.
        rollBackClaim();
      }
    }

    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        processing = processing.then(() => handleLine(line)).catch((error) => {
          process.stderr.write(
            `Failed to process broker request: ${error instanceof Error ? error.message : String(error)}\n`
          );
        });
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      void releaseThreadOwners(socket);
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      void releaseThreadOwners(socket);
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
