// Minimal stand-in for scripts/app-server-broker.mjs used by broker-lifecycle
// tests. Listens on the unix endpoint, writes the pid file, optionally records
// the CODEX_HOME it was spawned with (FAKE_BROKER_RECORD), and exits cleanly on
// the broker/shutdown RPC — the same surface ensureBrokerSession relies on.
import fs from "node:fs";
import net from "node:net";
import process from "node:process";

const args = process.argv.slice(2);

function opt(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const endpoint = opt("--endpoint");
const pidFile = opt("--pid-file");
if (!endpoint) {
  process.exit(1);
}
const socketPath = endpoint.replace(/^unix:/, "");

if (process.env.FAKE_BROKER_RECORD) {
  fs.writeFileSync(process.env.FAKE_BROKER_RECORD, process.env.CODEX_HOME ?? "");
}

const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    if (chunk.includes("broker/shutdown")) {
      socket.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
      socket.end();
      server.close(() => process.exit(0));
    }
  });
});

server.listen(socketPath, () => {
  if (pidFile) {
    fs.writeFileSync(pidFile, String(process.pid));
  }
});
