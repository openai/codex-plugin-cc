import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const BROKER = path.join(ROOT, "plugins", "codex", "scripts", "app-server-broker.mjs");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitWithTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 25 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return true;
    }
    await delay(intervalMs);
  }
  return false;
}

function readState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function startBroker(behavior = "review-ok") {
  const binDir = makeTempDir("codex-broker-bin-");
  installFakeCodex(binDir, behavior);
  const sessionDir = makeTempDir("codex-broker-subscriptions-");
  const cwd = makeTempDir("codex-broker-cwd-");
  const socketPath = path.join(sessionDir, "broker.sock");
  const pidFile = path.join(sessionDir, "broker.pid");
  const statePath = path.join(binDir, "fake-codex-state.json");
  const tempDirs = [binDir, sessionDir, cwd];

  const child = spawn(
    process.execPath,
    [BROKER, "serve", "--endpoint", `unix:${socketPath}`, "--cwd", cwd, "--pid-file", pidFile],
    { env: buildEnv(binDir), stdio: ["ignore", "pipe", "pipe"] }
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  async function stop() {
    try {
      if (child.exitCode !== null || child.signalCode !== null) {
        await exited;
        return;
      }
      child.kill("SIGTERM");
      const result = await waitWithTimeout(exited, 5000);
      if (!result) {
        child.kill("SIGKILL");
        await exited;
      }
    } finally {
      for (const tempDir of tempDirs) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }

  return {
    socketPath,
    statePath,
    stderr: () => stderr,
    listening: () => waitFor(() => fs.existsSync(socketPath)),
    stop
  };
}

async function connectClient(socketPath) {
  const socket = await new Promise((resolve, reject) => {
    const candidate = net.createConnection({ path: socketPath });
    candidate.on("connect", () => resolve(candidate));
    candidate.on("error", reject);
  });
  socket.setEncoding("utf8");

  let nextId = 1;
  let buffer = "";
  const pending = new Map();
  const notifications = [];
  const notificationWaiters = new Set();
  const closed = new Promise((resolve) => socket.on("close", resolve));

  function notifyWaiters(message) {
    for (const waiter of [...notificationWaiters]) {
      if (waiter.predicate(message)) {
        waiter.settle(message);
      }
    }
  }

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
      const message = JSON.parse(line);
      if (message.id !== undefined) {
        const request = pending.get(message.id);
        if (request) {
          pending.delete(message.id);
          if (message.error) {
            request.reject(new Error(message.error.message));
          } else {
            request.resolve(message.result);
          }
        }
        continue;
      }
      notifications.push(message);
      notifyWaiters(message);
    }
  });

  socket.on("error", (error) => {
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  });

  function request(method, params = {}) {
    const id = nextId++;
    const response = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    socket.write(`${JSON.stringify({ id, method, params })}\n`);
    return response;
  }

  async function waitForNotification(predicate, timeoutMs = 10000) {
    const existing = notifications.find(predicate);
    if (existing) {
      return existing;
    }
    return new Promise((resolve) => {
      let timer;
      const waiter = {
        predicate,
        settle(message) {
          clearTimeout(timer);
          notificationWaiters.delete(waiter);
          resolve(message);
        }
      };
      timer = setTimeout(() => waiter.settle(null), timeoutMs);
      notificationWaiters.add(waiter);
    });
  }

  await request("initialize", {});
  return {
    request,
    waitForNotification,
    async end() {
      socket.end();
      await closed;
    },
    destroy() {
      socket.destroy();
    }
  };
}

async function waitForUnsubscribes(statePath, expectedThreadIds) {
  const expected = [...expectedThreadIds].sort();
  const found = await waitFor(() => {
    const actual = [...(readState(statePath)?.unsubscribeRequests ?? [])].sort();
    return actual.length === expected.length && actual.every((threadId, index) => threadId === expected[index]);
  });
  assert.equal(found, true, `expected unsubscribe requests for ${expected.join(", ")}`);
}

test("broker unsubscribes a completed task thread when its client closes", async (t) => {
  const broker = startBroker();
  t.after(() => broker.stop());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const client = await connectClient(broker.socketPath);
  const started = await client.request("thread/start", { cwd: process.cwd(), ephemeral: true });
  const threadId = started.thread.id;
  await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "test normal completion" }]
  });
  const completed = await client.waitForNotification(
    (message) => message.method === "turn/completed" && message.params?.threadId === threadId
  );
  assert.ok(completed, "task never completed");

  await client.end();
  await waitForUnsubscribes(broker.statePath, [threadId]);
  assert.deepEqual(readState(broker.statePath).subscriptions, []);
});

test("broker keeps a resumed thread subscribed until its final client closes", async (t) => {
  const broker = startBroker();
  t.after(() => broker.stop());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const firstClient = await connectClient(broker.socketPath);
  const threadId = (await firstClient.request("thread/start", { cwd: process.cwd(), ephemeral: false })).thread.id;
  const secondClient = await connectClient(broker.socketPath);
  await secondClient.request("thread/resume", { threadId });

  await firstClient.end();
  await delay(250);
  assert.deepEqual(readState(broker.statePath).unsubscribeRequests, []);

  await secondClient.end();
  await waitForUnsubscribes(broker.statePath, [threadId]);
});

test("broker serializes a resume behind an in-flight unsubscribe", async (t) => {
  const broker = startBroker("unsubscribe-delayed");
  t.after(() => broker.stop());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const firstClient = await connectClient(broker.socketPath);
  const threadId = (await firstClient.request("thread/start", { cwd: process.cwd(), ephemeral: false })).thread.id;
  await firstClient.end();
  const unsubscribeStarted = await waitFor(() =>
    readState(broker.statePath)?.unsubscribeRequests?.includes(threadId)
  );
  assert.equal(unsubscribeStarted, true, "unsubscribe request was not observed");

  const secondClient = await connectClient(broker.socketPath);
  await secondClient.request("thread/resume", { threadId });
  assert.deepEqual(readState(broker.statePath).requestOrder, ["unsubscribe:response", "thread/resume"]);
  assert.deepEqual(readState(broker.statePath).subscriptions, [threadId]);

  await secondClient.end();
  await waitForUnsubscribes(broker.statePath, [threadId, threadId]);
  assert.deepEqual(readState(broker.statePath).subscriptions, []);
});

test("broker cancels a retry when a client reacquires the thread", async (t) => {
  const broker = startBroker("unsubscribe-fails-once");
  t.after(() => broker.stop());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const firstClient = await connectClient(broker.socketPath);
  const threadId = (await firstClient.request("thread/start", { cwd: process.cwd(), ephemeral: false })).thread.id;
  await firstClient.end();
  const firstAttemptObserved = await waitFor(
    () => readState(broker.statePath)?.unsubscribeRequests?.length === 1
  );
  assert.equal(firstAttemptObserved, true, "initial unsubscribe request was not observed");

  const secondClient = await connectClient(broker.socketPath);
  await secondClient.request("thread/resume", { threadId });
  await delay(3000);
  assert.deepEqual(readState(broker.statePath).subscriptions, [threadId]);

  await secondClient.end();
  const unsubscribed = await waitFor(() => readState(broker.statePath)?.subscriptions?.length === 0);
  assert.equal(unsubscribed, true, "reacquired thread was not unsubscribed after its final owner closed");
  assert.equal(readState(broker.statePath).unsubscribeRequests.at(-1), threadId);
});

test("broker unsubscribes source and detached review threads", async (t) => {
  const broker = startBroker();
  t.after(() => broker.stop());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const client = await connectClient(broker.socketPath);
  const sourceThreadId = (await client.request("thread/start", { cwd: process.cwd(), ephemeral: true })).thread.id;
  const review = await client.request("review/start", {
    threadId: sourceThreadId,
    delivery: "detached",
    target: { type: "uncommittedChanges" }
  });
  assert.notEqual(review.reviewThreadId, sourceThreadId);
  const completed = await client.waitForNotification(
    (message) => message.method === "turn/completed" && message.params?.threadId === review.reviewThreadId
  );
  assert.ok(completed, "review never completed");

  await client.end();
  await waitForUnsubscribes(broker.statePath, [sourceThreadId, review.reviewThreadId]);
});

test("broker unsubscribes a forked thread when its client closes", async (t) => {
  const broker = startBroker();
  t.after(() => broker.stop());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const client = await connectClient(broker.socketPath);
  const sourceThreadId = (await client.request("thread/start", { cwd: process.cwd(), ephemeral: false })).thread.id;
  const forkThreadId = (await client.request("thread/fork", { threadId: sourceThreadId, ephemeral: true })).thread.id;

  await client.end();
  await waitForUnsubscribes(broker.statePath, [sourceThreadId, forkThreadId]);
});

test("broker unsubscribes when a client disconnects during an active turn", async (t) => {
  const broker = startBroker("slow-task");
  t.after(() => broker.stop());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const client = await connectClient(broker.socketPath);
  const threadId = (await client.request("thread/start", { cwd: process.cwd(), ephemeral: true })).thread.id;
  await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "disconnect this client" }]
  });
  client.destroy();

  await waitForUnsubscribes(broker.statePath, [threadId]);
});

test("broker unsubscribes auto-subscribed subagent threads", async (t) => {
  const broker = startBroker("with-subagent");
  t.after(() => broker.stop());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const client = await connectClient(broker.socketPath);
  const threadId = (await client.request("thread/start", { cwd: process.cwd(), ephemeral: true })).thread.id;
  await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "delegate this task" }]
  });
  const completed = await client.waitForNotification(
    (message) => message.method === "turn/completed" && message.params?.threadId === threadId
  );
  assert.ok(completed, "task never completed");

  const subagentThread = readState(broker.statePath).threads.find((thread) => thread.name === "design-challenger");
  assert.ok(subagentThread, "subagent thread was not created");

  await client.end();
  await waitForUnsubscribes(broker.statePath, [threadId, subagentThread.id]);
  assert.deepEqual(readState(broker.statePath).subscriptions, []);
});

test("broker tracks subagent subscriptions from collaboration items", async (t) => {
  const broker = startBroker("with-receiver-only-subagent");
  t.after(() => broker.stop());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const client = await connectClient(broker.socketPath);
  const threadId = (await client.request("thread/start", { cwd: process.cwd(), ephemeral: true })).thread.id;
  await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "delegate without a thread-started notification" }]
  });
  const completed = await client.waitForNotification(
    (message) => message.method === "turn/completed" && message.params?.threadId === threadId
  );
  assert.ok(completed, "task never completed");

  const subagentThread = readState(broker.statePath).threads.find((thread) => thread.name === "design-challenger");
  assert.ok(subagentThread, "subagent thread was not created");

  await client.end();
  await waitForUnsubscribes(broker.statePath, [threadId, subagentThread.id]);
  assert.deepEqual(readState(broker.statePath).subscriptions, []);
});

test("broker unsubscribes a child thread created after its client disconnects", async (t) => {
  const broker = startBroker("with-delayed-subagent");
  t.after(() => broker.stop());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const client = await connectClient(broker.socketPath);
  const threadId = (await client.request("thread/start", { cwd: process.cwd(), ephemeral: true })).thread.id;
  await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "disconnect before delegation" }]
  });
  client.destroy();

  const childCreated = await waitFor(() =>
    readState(broker.statePath)?.threads.some((thread) => thread.name === "delayed-design-challenger")
  );
  assert.equal(childCreated, true, "delayed child thread was not created");
  const childThread = readState(broker.statePath).threads.find(
    (thread) => thread.name === "delayed-design-challenger"
  );

  await waitForUnsubscribes(broker.statePath, [threadId, childThread.id]);
  assert.deepEqual(readState(broker.statePath).subscriptions, []);
});

test("broker does not assign a delayed child thread to an unrelated active client", async (t) => {
  const broker = startBroker("with-delayed-subagent");
  t.after(() => broker.stop());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const firstClient = await connectClient(broker.socketPath);
  const firstThreadId = (
    await firstClient.request("thread/start", { cwd: process.cwd(), ephemeral: true })
  ).thread.id;
  await firstClient.request("turn/start", {
    threadId: firstThreadId,
    input: [{ type: "text", text: "create a delayed child" }]
  });
  firstClient.destroy();

  const secondClient = await connectClient(broker.socketPath);
  const secondThreadId = (
    await secondClient.request("thread/start", { cwd: process.cwd(), ephemeral: true })
  ).thread.id;
  await secondClient.request("turn/start", {
    threadId: secondThreadId,
    input: [{ type: "text", text: "remain active while the first child arrives" }]
  });

  const childrenCreated = await waitFor(
    () => readState(broker.statePath)?.threads.filter((thread) => thread.parentThreadId).length === 2
  );
  assert.equal(childrenCreated, true, "delayed child threads were not created");

  const state = readState(broker.statePath);
  const firstChild = state.threads.find((thread) => thread.parentThreadId === firstThreadId);
  const secondChild = state.threads.find((thread) => thread.parentThreadId === secondThreadId);
  assert.ok(firstChild, "the first client's child thread was not recorded");
  assert.ok(secondChild, "the second client's child thread was not recorded");

  const firstReleased = await waitFor(() => {
    const requests = readState(broker.statePath)?.unsubscribeRequests ?? [];
    return requests.includes(firstThreadId) && requests.includes(firstChild.id);
  });
  assert.equal(firstReleased, true, "the disconnected client's subscriptions were not released");
  const requestsBeforeSecondClientCloses = readState(broker.statePath).unsubscribeRequests;
  assert.equal(requestsBeforeSecondClientCloses.includes(secondThreadId), false);
  assert.equal(requestsBeforeSecondClientCloses.includes(secondChild.id), false);

  await secondClient.end();
  await waitForUnsubscribes(broker.statePath, [firstThreadId, firstChild.id, secondThreadId, secondChild.id]);
  assert.deepEqual(readState(broker.statePath).subscriptions, []);
});

test("broker serializes subscription requests from one downstream client", async (t) => {
  const broker = startBroker("overlapping-resume");
  t.after(() => broker.stop());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const firstClient = await connectClient(broker.socketPath);
  const threadId = (await firstClient.request("thread/start", { cwd: process.cwd(), ephemeral: false })).thread.id;
  const secondClient = await connectClient(broker.socketPath);
  const results = await Promise.allSettled([
    secondClient.request("thread/resume", { threadId, persistFullHistory: true }),
    secondClient.request("thread/resume", { threadId })
  ]);
  assert.equal(results[0].status, "rejected");
  assert.match(results[0].reason.message, /forced delayed resume failure/);
  assert.equal(results[1].status, "fulfilled");

  await firstClient.end();
  await delay(250);
  assert.deepEqual(readState(broker.statePath).unsubscribeRequests, []);
  assert.deepEqual(readState(broker.statePath).subscriptions, [threadId]);

  await secondClient.end();
  await waitForUnsubscribes(broker.statePath, [threadId]);
});

test("broker replies to a failed resume even when the upstream unsubscribe hangs", async (t) => {
  const broker = startBroker("resume-fails-unsubscribe-hangs");
  t.after(() => broker.stop());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  // Nobody owns this thread, so the failed provisional claim releases it upstream.
  const threadId = "thr_unowned";
  const firstClient = await connectClient(broker.socketPath);
  const failedResume = await waitWithTimeout(
    firstClient.request("thread/resume", { threadId, persistFullHistory: true }).then(
      () => ({ status: "fulfilled" }),
      (error) => ({ status: "rejected", error })
    ),
    2000
  );
  assert.notEqual(failedResume, null, "failed resume did not receive a response");
  assert.equal(failedResume.status, "rejected");
  assert.match(failedResume.error.message, /forced resume failure/);

  const secondClient = await connectClient(broker.socketPath);
  const secondStarted = await waitWithTimeout(
    secondClient.request("thread/start", { cwd: process.cwd(), ephemeral: false }),
    2000
  );
  assert.notEqual(secondStarted, null, "broker remained busy after the failed resume");

  const unsubscribeStarted = await waitFor(() =>
    readState(broker.statePath)?.unsubscribeRequests?.includes(threadId)
  );
  assert.equal(unsubscribeStarted, true, "the released thread was not unsubscribed upstream");
  await secondClient.end();
  await firstClient.end();
});

test("broker keeps shared upstream subscriptions when one client explicitly unsubscribes", async (t) => {
  const broker = startBroker();
  t.after(() => broker.stop());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const firstClient = await connectClient(broker.socketPath);
  const threadId = (await firstClient.request("thread/start", { cwd: process.cwd(), ephemeral: false })).thread.id;
  const secondClient = await connectClient(broker.socketPath);
  await secondClient.request("thread/resume", { threadId });

  assert.deepEqual(await firstClient.request("thread/unsubscribe", { threadId }), { status: "unsubscribed" });
  assert.deepEqual(readState(broker.statePath).unsubscribeRequests, []);
  assert.deepEqual(readState(broker.statePath).subscriptions, [threadId]);

  const thirdClient = await connectClient(broker.socketPath);
  assert.deepEqual(await thirdClient.request("thread/unsubscribe", { threadId }), { status: "notSubscribed" });
  assert.deepEqual(readState(broker.statePath).unsubscribeRequests, []);

  await firstClient.end();
  await thirdClient.end();
  await secondClient.end();
  await waitForUnsubscribes(broker.statePath, [threadId]);
  assert.deepEqual(readState(broker.statePath).subscriptions, []);
});

test("broker does not reclaim ownership from notifications during explicit unsubscribe", async (t) => {
  const broker = startBroker("unsubscribe-notifies");
  t.after(() => broker.stop());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const client = await connectClient(broker.socketPath);
  const threadId = (await client.request("thread/start", { cwd: process.cwd(), ephemeral: true })).thread.id;
  assert.deepEqual(await client.request("thread/unsubscribe", { threadId }), { status: "unsubscribed" });
  await client.end();
  await delay(250);

  assert.deepEqual(readState(broker.statePath).unsubscribeRequests, [threadId]);
  assert.deepEqual(readState(broker.statePath).subscriptions, []);
});

test("broker logs upstream unsubscribe failures", async (t) => {
  const broker = startBroker("unsubscribe-fails");
  t.after(() => broker.stop());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const client = await connectClient(broker.socketPath);
  const threadId = (await client.request("thread/start", { cwd: process.cwd(), ephemeral: true })).thread.id;
  await client.end();

  const requestObserved = await waitFor(() => readState(broker.statePath)?.unsubscribeRequests?.includes(threadId));
  assert.equal(requestObserved, true, "unsubscribe request was not observed");
  const warningObserved = await waitFor(
    () => broker.stderr().includes(`Failed to unsubscribe Codex thread ${threadId}: thread unsubscribe failed`)
  );
  assert.equal(warningObserved, true, "unsubscribe failure was not logged");
  const retryBoundReached = await waitFor(
    () => readState(broker.statePath)?.unsubscribeRequests?.length === 4,
    { timeoutMs: 6000 }
  );
  assert.equal(retryBoundReached, true, "unsubscribe retries did not reach the expected bound");
  await delay(500);
  assert.equal(readState(broker.statePath).unsubscribeRequests.length, 4);
  assert.deepEqual(readState(broker.statePath).subscriptions, [threadId]);
});

test("broker retries a transient upstream unsubscribe failure", async (t) => {
  const broker = startBroker("unsubscribe-fails-once");
  t.after(() => broker.stop());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const client = await connectClient(broker.socketPath);
  const threadId = (await client.request("thread/start", { cwd: process.cwd(), ephemeral: true })).thread.id;
  await client.end();

  const retried = await waitFor(() => {
    const state = readState(broker.statePath);
    return state?.unsubscribeRequests?.length === 2 && state.subscriptions.length === 0;
  });
  assert.equal(retried, true, "the failed unsubscribe was not retried");
  assert.deepEqual(readState(broker.statePath).unsubscribeRequests, [threadId, threadId]);
  assert.match(broker.stderr(), new RegExp(`Failed to unsubscribe Codex thread ${threadId}`));
});

test("broker fails a resume when an in-flight unsubscribe outlives the bounded wait", async (t) => {
  const broker = startBroker("resume-fails-unsubscribe-hangs");
  t.after(() => broker.stop());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const firstClient = await connectClient(broker.socketPath);
  const threadId = (await firstClient.request("thread/start", { cwd: process.cwd(), ephemeral: false })).thread.id;
  await firstClient.end();
  const unsubscribeStarted = await waitFor(() =>
    readState(broker.statePath)?.unsubscribeRequests?.includes(threadId)
  );
  assert.equal(unsubscribeStarted, true, "unsubscribe request was not observed");

  const secondClient = await connectClient(broker.socketPath);
  const startedAt = Date.now();
  const resumed = await waitWithTimeout(
    secondClient.request("thread/resume", { threadId }).then(
      () => ({ status: "fulfilled" }),
      (error) => ({ status: "rejected", error })
    ),
    8000
  );
  assert.notEqual(resumed, null, "resume never settled while the upstream unsubscribe hung");
  assert.equal(resumed.status, "rejected");
  assert.match(resumed.error.message, /still being released upstream/);
  assert.ok(Date.now() - startedAt >= 4000, "resume did not wait for the in-flight unsubscribe");
  // The resume was never sent upstream, so the fake still lists only the original subscription.
  assert.deepEqual(readState(broker.statePath).subscriptions, [threadId]);

  const thirdClient = await connectClient(broker.socketPath);
  const thirdStarted = await waitWithTimeout(
    thirdClient.request("thread/start", { cwd: process.cwd(), ephemeral: false }),
    2000
  );
  assert.notEqual(thirdStarted, null, "broker remained busy after the bounded wait");
  await thirdClient.end();
  await secondClient.end();
});

test("broker keeps rejecting claims until a hung unsubscribe settles", async (t) => {
  const broker = startBroker("resume-fails-unsubscribe-hangs");
  t.after(() => broker.stop());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const firstClient = await connectClient(broker.socketPath);
  const threadId = (await firstClient.request("thread/start", { cwd: process.cwd(), ephemeral: false })).thread.id;
  await firstClient.end();
  const unsubscribeStarted = await waitFor(() =>
    readState(broker.statePath)?.unsubscribeRequests?.includes(threadId)
  );
  assert.equal(unsubscribeStarted, true, "unsubscribe request was not observed");

  const attempt = async () => {
    const client = await connectClient(broker.socketPath);
    const outcome = await waitWithTimeout(
      client.request("thread/resume", { threadId }).then(
        () => ({ status: "fulfilled" }),
        (error) => ({ status: "rejected", error })
      ),
      8000
    );
    await client.end();
    return outcome;
  };

  // The first claim times out on the hung unsubscribe. Its release installs a
  // follow-up cleanup that must stay pending; a retry must still be rejected.
  const first = await attempt();
  assert.equal(first?.status, "rejected");
  assert.match(first.error.message, /still being released upstream/);
  const retry = await attempt();
  assert.equal(retry?.status, "rejected", "a retry slipped past the still-outstanding unsubscribe");
  assert.match(retry.error.message, /still being released upstream/);
  assert.deepEqual(readState(broker.statePath).requestOrder, []);
  assert.deepEqual(readState(broker.statePath).subscriptions, [threadId]);
});

test("broker rejects an explicit unsubscribe that would queue behind a hung cleanup", async (t) => {
  const broker = startBroker("resume-fails-unsubscribe-hangs");
  t.after(() => broker.stop());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const firstClient = await connectClient(broker.socketPath);
  const threadId = (await firstClient.request("thread/start", { cwd: process.cwd(), ephemeral: false })).thread.id;
  await firstClient.end();
  const unsubscribeStarted = await waitFor(() =>
    readState(broker.statePath)?.unsubscribeRequests?.includes(threadId)
  );
  assert.equal(unsubscribeStarted, true, "unsubscribe request was not observed");

  const secondClient = await connectClient(broker.socketPath);
  const explicit = await waitWithTimeout(
    secondClient.request("thread/unsubscribe", { threadId }).then(
      () => ({ status: "fulfilled" }),
      (error) => ({ status: "rejected", error })
    ),
    8000
  );
  assert.notEqual(explicit, null, "explicit unsubscribe never settled behind the hung cleanup");
  assert.equal(explicit.status, "rejected");
  assert.match(explicit.error.message, /still being released upstream/);

  const thirdClient = await connectClient(broker.socketPath);
  const thirdStarted = await waitWithTimeout(
    thirdClient.request("thread/start", { cwd: process.cwd(), ephemeral: false }),
    2000
  );
  assert.notEqual(thirdStarted, null, "broker remained busy after the rejected explicit unsubscribe");
  // Only the original hung request reached upstream; nothing else was queued.
  assert.deepEqual(readState(broker.statePath).unsubscribeRequests, [threadId]);
  await thirdClient.end();
  await secondClient.end();
});

test("broker rolls back child threads inherited through a failed provisional claim", async (t) => {
  const broker = startBroker("with-delayed-subagent");
  t.after(() => broker.stop());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const firstClient = await connectClient(broker.socketPath);
  const threadId = (await firstClient.request("thread/start", { cwd: process.cwd(), ephemeral: false })).thread.id;
  await firstClient.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "spawn a child while another client is resuming" }]
  });
  firstClient.destroy();
  await waitForUnsubscribes(broker.statePath, [threadId]);

  // The resume fails after 250 ms; the delayed child arrives at 100 ms while the
  // claim is still open, so the claiming socket inherits it.
  const secondClient = await connectClient(broker.socketPath);
  await assert.rejects(
    secondClient.request("thread/resume", { threadId, persistFullHistory: true }),
    /forced resume failure after child arrival/
  );
  const childThread = readState(broker.statePath).threads.find(
    (thread) => thread.name === "delayed-design-challenger"
  );
  assert.ok(childThread, "delayed child thread was not created");
  const grandchildCreated = await waitFor(() =>
    readState(broker.statePath)?.threads.some((thread) => thread.name === "delayed-design-grandchild")
  );
  assert.equal(grandchildCreated, true, "delayed grandchild thread was not created");
  const grandchildThread = readState(broker.statePath).threads.find(
    (thread) => thread.name === "delayed-design-grandchild"
  );

  // The parent, the inherited child, and the nested grandchild are all released
  // while the client stays connected.
  await waitForUnsubscribes(broker.statePath, [threadId, threadId, childThread.id, grandchildThread.id]);
  assert.deepEqual(readState(broker.statePath).subscriptions, []);
  await secondClient.end();
});

test("broker retries cleanup when a client disconnects during a failing explicit unsubscribe", async (t) => {
  const broker = startBroker("unsubscribe-fails-once-delayed");
  t.after(() => broker.stop());
  assert.equal(await broker.listening(), true, `broker never listened: ${broker.stderr()}`);

  const client = await connectClient(broker.socketPath);
  const threadId = (await client.request("thread/start", { cwd: process.cwd(), ephemeral: false })).thread.id;
  // Send the explicit unsubscribe and drop the socket before the upstream reply.
  void client.request("thread/unsubscribe", { threadId }).catch(() => {});
  await waitFor(() => readState(broker.statePath)?.unsubscribeRequests?.length === 1);
  client.destroy();

  // The first attempt fails 300 ms later, after the requester is gone; the broker must retry on its own.
  await waitForUnsubscribes(broker.statePath, [threadId, threadId]);
  assert.deepEqual(readState(broker.statePath).subscriptions, []);
});
