/**
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {import("./app-server-protocol").AppServerMethod} AppServerMethod
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").AppServerNotificationHandler} AppServerNotificationHandler
 * @typedef {import("./app-server-protocol").ClientInfo} ClientInfo
 * @typedef {import("./app-server-protocol").CodexAppServerClientOptions} CodexAppServerClientOptions
 * @typedef {import("./app-server-protocol").InitializeCapabilities} InitializeCapabilities
 */
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { terminateProcessTree } from "./process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;

const CHILD_STDIN_GRACE_MS = 1000;
const CHILD_TERMINATION_GRACE_MS = 1000;
const CHILD_EXIT_DIAGNOSTIC_GRACE_MS = 250;
const APP_SERVER_INITIALIZE_TIMEOUT_MS = 15000;
const BROKER_SOCKET_CLOSE_GRACE_MS = 1000;

/** @type {ClientInfo} */
const DEFAULT_CLIENT_INFO = {
  title: "Codex Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

/** @type {InitializeCapabilities} */
const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

function settlesWithin(promise, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

class AppServerClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.terminalCause = null;
    this.terminalListeners = new Set();
    /** @type {AppServerNotificationHandler | null} */
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";

    this.terminalPromise = new Promise((resolve) => {
      this.resolveTerminal = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  onTerminal(listener) {
    if (this.terminalCause) {
      listener(this.terminalCause);
      return () => {};
    }
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  /**
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("./app-server-protocol").AppServerRequestParams<M>} params
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
   */
  request(method, params) {
    if (this.terminalCause) {
      throw this.terminalCause;
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ id, method, params });
    });
  }

  notify(method, params = {}) {
    if (this.terminalCause) {
      return;
    }
    this.sendMessage({ method, params });
  }

  async initializeProtocol() {
    const initializeTimeout = setTimeout(() => {
      this.transitionToTerminal(createProtocolError("codex app-server initialization timed out."));
    }, APP_SERVER_INITIALIZE_TIMEOUT_MS);
    try {
      await this.request("initialize", {
        clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
        capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
      });
    } finally {
      clearTimeout(initializeTimeout);
    }
    this.notify("initialized", {});
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (this.terminalCause) {
      return;
    }
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.transitionToTerminal(createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }));
      return;
    }

    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      this.transitionToTerminal(createProtocolError("Invalid codex app-server JSONL message: expected an object.", { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      try {
        this.notificationHandler(/** @type {AppServerNotification} */ (message));
      } catch (error) {
        this.transitionToTerminal(error);
      }
    }
  }

  handleServerRequest(message) {
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  transitionToTerminal(error) {
    if (this.terminalCause) {
      return;
    }

    this.terminalCause = error ?? new Error("codex app-server connection closed.");

    for (const pending of this.pending.values()) {
      pending.reject(this.terminalCause);
    }
    this.pending.clear();
    for (const listener of this.terminalListeners) {
      listener(this.terminalCause);
    }
    this.terminalListeners.clear();
    this.resolveTerminal(undefined);
  }

  sendMessage(message) {
    if (this.terminalCause) {
      return false;
    }
    try {
      this.writeMessage(message);
      return true;
    } catch (error) {
      this.transitionToTerminal(error);
      return false;
    }
  }

  writeMessage(_message) {
    throw new Error("writeMessage must be implemented by subclasses.");
  }
}

class SpawnedCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
    this.closePromise = null;
  }

  async initialize() {
    this.proc = spawn("codex", ["app-server"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    this.childExitedPromise = new Promise((resolve) => {
      this.proc.once("close", resolve);
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.proc.stdin.on("error", (error) => {
      this.transitionToTerminal(error);
    });

    this.proc.stdout.on("end", () => {
      // Child close follows stream EOF for ordinary process exits and carries
      // the exit status after stderr has drained.
      const diagnosticTimer = setTimeout(() => {
        if (!this.terminalCause) {
          this.transitionToTerminal(createProtocolError("codex app-server stdout closed before the connection ended."));
        }
      }, CHILD_EXIT_DIAGNOSTIC_GRACE_MS);
      diagnosticTimer.unref?.();
      this.proc.once("close", () => clearTimeout(diagnosticTimer));
    });

    this.proc.on("error", (error) => {
      this.transitionToTerminal(error);
    });

    this.proc.on("close", (code, signal) => {
      const stderr = this.stderr.trim();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.transitionToTerminal(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await this.initializeProtocol();
  }

  async close() {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = Promise.resolve().then(async () => {
      if (this.readline) {
        this.readline.close();
      }

      if (!this.proc || !this.childExitedPromise) {
        return;
      }
      if (this.proc.exitCode === null && !this.proc.killed) {
        this.proc.stdin.end();
      }
      if (await settlesWithin(this.childExitedPromise, CHILD_STDIN_GRACE_MS)) {
        return;
      }

      try {
        terminateProcessTree(this.proc.pid);
      } catch {
        // The child may have exited between the grace deadline and termination.
      }
      if (!(await settlesWithin(this.childExitedPromise, CHILD_TERMINATION_GRACE_MS))) {
        try {
          terminateProcessTree(this.proc.pid, { signal: "SIGKILL" });
        } catch {
          // The process tree may have exited during escalation.
        }
      }
      await this.childExitedPromise;
    });
    this.transitionToTerminal(new Error("codex app-server client is closed."));
    return this.closePromise;
  }

  writeMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
    this.closePromise = null;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socketClosedPromise = new Promise((resolve) => {
        this.socket.once("close", resolve);
      });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.terminalCause) {
          reject(error);
        }
        this.transitionToTerminal(error);
      });
      this.socket.on("close", () => {
        this.transitionToTerminal(this.terminalCause);
      });
    });

    await this.initializeProtocol();
  }

  async close() {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = Promise.resolve().then(async () => {
      if (this.socket && !this.socket.destroyed) {
        this.socket.end();
      }
      if (this.socketClosedPromise && !(await settlesWithin(this.socketClosedPromise, BROKER_SOCKET_CLOSE_GRACE_MS))) {
        this.socket.destroy();
      }
      if (this.socketClosedPromise) {
        await this.socketClosedPromise;
      }
    });
    this.transitionToTerminal(new Error("codex app-server client is closed."));
    return this.closePromise;
  }

  writeMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class CodexAppServerClient {
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedCodexAppServerClient(cwd, options);
    try {
      await client.initialize();
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }
}
