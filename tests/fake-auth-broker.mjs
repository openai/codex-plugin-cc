#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import process from "node:process";

import { parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";

const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  options[args[index]?.replace(/^--/, "")] = args[index + 1];
}

if (!options.endpoint || !options.state || !options.mode) {
  throw new Error("Usage: node tests/fake-auth-broker.mjs --endpoint <endpoint> --state <path> --mode <busy|error>");
}

const target = parseBrokerEndpoint(options.endpoint);
const state = {
  ready: false,
  connections: 0,
  closedConnections: 0,
  requests: []
};

function saveState() {
  fs.writeFileSync(options.state, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function send(socket, message) {
  socket.write(`${JSON.stringify(message)}\n`);
}

const server = net.createServer((socket) => {
  state.connections += 1;
  saveState();
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

      const message = JSON.parse(line);
      if (message.id === undefined) {
        continue;
      }
      state.requests.push(message.method);
      saveState();

      if (message.method === "initialize") {
        send(socket, { id: message.id, result: { userAgent: "fake-auth-broker" } });
      } else if (options.mode === "busy") {
        send(socket, {
          id: message.id,
          error: { code: -32001, message: "Shared Codex broker is busy." }
        });
      } else {
        send(socket, {
          id: message.id,
          error: { code: -32099, message: "Broker auth request failed." }
        });
      }
    }
  });

  socket.on("close", () => {
    state.closedConnections += 1;
    saveState();
  });
});

function shutdown() {
  server.close(() => {
    if (target.kind === "unix" && fs.existsSync(target.path)) {
      fs.unlinkSync(target.path);
    }
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(target.path, () => {
  state.ready = true;
  saveState();
});
