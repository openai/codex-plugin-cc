
import net from "node:net";
import path from "node:path";
import os from "node:os";

export function createControllerEndpoint(workspaceKey, platform = process.platform) {
  if (platform === "win32") return `pipe:\\\\.\\pipe\\${workspaceKey}-codex-orchestrator`;
  return `unix:${path.join(os.tmpdir(), "codex-orchestration-runtime", workspaceKey, "controller.sock")}`;
}
export function parseControllerEndpoint(endpoint) {
  if (endpoint.startsWith("unix:")) return { kind: "unix", path: endpoint.slice(5) };
  if (endpoint.startsWith("pipe:")) return { kind: "pipe", path: endpoint.slice(5) };
  throw new Error(`Unsupported controller endpoint: ${endpoint}`);
}
export function requestController(endpoint, method, params = {}, options = {}) {
  const target = parseControllerEndpoint(endpoint);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: target.path }); let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Controller request timed out: ${method}`)); }, options.timeoutMs ?? 10_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: 1, method, params })}\n`));
    socket.on("data", (chunk) => { buffer += chunk; const index = buffer.indexOf("\n"); if (index < 0) return; clearTimeout(timer); socket.end(); const message = JSON.parse(buffer.slice(0, index)); if (message.error) reject(Object.assign(new Error(message.error.message), { rpcCode: message.error.code })); else resolve(message.result); });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}
