import net from "node:net";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";

const BROKER_BUSY_RPC_CODE = -32001;
const BROKER_PROBE_TIMEOUT_MS = 500;

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

function sendJsonLine(socket, message) {
  socket.write(`${JSON.stringify(message)}\n`);
}

function handleProbeMessage(message, phase, socket, cwd) {
  if (message.error) {
    return { status: message.error.code === BROKER_BUSY_RPC_CODE ? "busy" : "unknown" };
  }
  if (phase === "initialize" && message.id === 1) {
    sendJsonLine(socket, { method: "initialized", params: {} });
    sendJsonLine(socket, { id: 2, method: "thread/list", params: { cwd, limit: 1 } });
    return { phase: "probe" };
  }
  if (phase === "probe" && message.id === 2) {
    return { status: "idle" };
  }
  return {};
}

function consumeProbeData(buffer, chunk, phase, socket, cwd, finish) {
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
    } catch {
      finish("unknown");
      return { buffer, phase };
    }
    const next = handleProbeMessage(message, phase, socket, cwd);
    if (next.status) {
      finish(next.status);
      return { buffer, phase };
    }
    phase = next.phase ?? phase;
  }
  return { buffer, phase };
}

export async function probeBroker(endpoint, cwd, timeoutMs = BROKER_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    let buffer = "";
    let phase = "initialize";
    let settled = false;
    const timer = setTimeout(() => finish("unknown"), timeoutMs);

    function finish(status) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(status);
    }

    socket.setEncoding("utf8");
    socket.on("connect", () => sendJsonLine(socket, {
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { title: "Codex Plugin Broker Probe", name: "Claude Code", version: "0.0.0" },
        capabilities: { experimentalApi: false, requestAttestation: false }
      }
    }));
    socket.on("data", (chunk) => {
      ({ buffer, phase } = consumeProbeData(buffer, chunk, phase, socket, cwd, finish));
    });
    socket.on("error", () => finish("unknown"));
    socket.on("close", () => finish("unknown"));
  });
}
