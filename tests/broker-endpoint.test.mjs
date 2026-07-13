import fs from "node:fs";
import net from "node:net";
import test from "node:test";
import assert from "node:assert/strict";

import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { sendBrokerShutdown } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { makeTempDir } from "./helpers.mjs";

async function listenForBrokerResponse(t, response = undefined) {
  const sessionDir = makeTempDir("codex-broker-response-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const target = parseBrokerEndpoint(endpoint);
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("data", () => {
      if (response !== undefined) {
        socket.write(`${JSON.stringify(response)}\n`);
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(target.path, () => {
      server.off("error", reject);
      resolve();
    });
  });

  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
    if (target.kind === "unix") {
      fs.rmSync(target.path, { force: true });
    }
  });

  return endpoint;
}

test("createBrokerEndpoint uses Unix sockets on non-Windows platforms", () => {
  const endpoint = createBrokerEndpoint("/tmp/cxc-12345", "darwin");
  assert.equal(endpoint, "unix:/tmp/cxc-12345/broker.sock");
  assert.deepEqual(parseBrokerEndpoint(endpoint), {
    kind: "unix",
    path: "/tmp/cxc-12345/broker.sock"
  });
});

test("createBrokerEndpoint uses named pipes on Windows", () => {
  const endpoint = createBrokerEndpoint("C:\\\\Temp\\\\cxc-12345", "win32");
  assert.equal(endpoint, "pipe:\\\\.\\pipe\\cxc-12345-codex-app-server");
  assert.deepEqual(parseBrokerEndpoint(endpoint), {
    kind: "pipe",
    path: "\\\\.\\pipe\\cxc-12345-codex-app-server"
  });
});

test("sendBrokerShutdown accepts an explicit successful response", async (t) => {
  const endpoint = await listenForBrokerResponse(t, { id: 1, result: {} });

  assert.equal(await sendBrokerShutdown(endpoint, 100), "accepted");
});

test("sendBrokerShutdown reports an explicit broker rejection", async (t) => {
  const endpoint = await listenForBrokerResponse(t, {
    id: 1,
    error: {
      code: -32001,
      message: "Shared Codex broker is busy."
    }
  });

  assert.equal(await sendBrokerShutdown(endpoint, 100), "rejected");
});

test("sendBrokerShutdown rejects a response without a result", async (t) => {
  const endpoint = await listenForBrokerResponse(t, { id: 1 });

  assert.equal(await sendBrokerShutdown(endpoint, 100), "rejected");
});

test("sendBrokerShutdown stops waiting when the broker does not respond", async (t) => {
  const endpoint = await listenForBrokerResponse(t);

  const startedAt = Date.now();
  const outcome = await sendBrokerShutdown(endpoint, 50);

  assert.equal(outcome, "timeout");
  assert.ok(Date.now() - startedAt < 1000);
});
