import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { makeTempDir } from "./helpers.mjs";
import { sendBrokerShutdown } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

test("sendBrokerShutdown returns when a broker accepts but never replies", async (t) => {
  const socketPath = path.join(makeTempDir(), "broker.sock");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
    fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
  });

  const startedAt = Date.now();
  await sendBrokerShutdown(`unix:${socketPath}`, 50);
  assert.ok(Date.now() - startedAt < 500);
});
