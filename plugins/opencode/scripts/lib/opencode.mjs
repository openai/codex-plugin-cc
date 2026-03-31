/**
 * OpenCode CLI integration.
 *
 * Unlike Codex (JSON-RPC app-server), OpenCode uses a simple CLI:
 *   opencode run [--continue] [--session <id>] [--format json] [--quiet] "prompt"
 */

import { spawn } from "node:child_process";
import { binaryAvailable, runCommand } from "./process.mjs";

/**
 * Check whether `opencode` is installed and reachable.
 * @param {string} cwd
 * @returns {{ available: boolean, detail: string }}
 */
export function getOpenCodeAvailability(cwd) {
  return binaryAvailable("opencode", ["version"], { cwd });
}

/**
 * Check whether the user is authenticated with OpenCode.
 * OpenCode doesn't have a dedicated `login status` command, so we just
 * check availability — authentication is handled via provider API keys
 * in the environment or opencode config.
 * @param {string} cwd
 * @returns {{ available: boolean, loggedIn: boolean, detail: string }}
 */
export function getOpenCodeAuthStatus(cwd) {
  const availability = getOpenCodeAvailability(cwd);
  if (!availability.available) {
    return { available: false, loggedIn: false, detail: availability.detail };
  }
  // OpenCode relies on provider API keys (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.)
  // We can't easily check that without trying a real call, so treat as ready if binary exists.
  return { available: true, loggedIn: true, detail: availability.detail };
}

/**
 * Run `opencode run` and capture its output.
 *
 * @param {string} cwd  Working directory (git root)
 * @param {object} options
 * @param {string}  options.prompt        The task prompt
 * @param {boolean} [options.continueSession]  Resume previous session (--continue)
 * @param {string}  [options.sessionId]   Specific session to resume (--session <id>)
 * @param {boolean} [options.write]       Allow file writes (default true)
 * @param {((msg: string) => void)|null} [options.onProgress]
 * @returns {Promise<{status: number, stdout: string, stderr: string, sessionId: string|null}>}
 */
export function runOpenCodeTask(cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const args = ["run"];

    // Session continuation
    if (options.sessionId) {
      args.push("--session", options.sessionId);
    } else if (options.continueSession) {
      args.push("--continue");
    }

    // Output format
    args.push("--format", "default");
    args.push("--quiet");

    // Prompt
    if (options.prompt) {
      args.push(options.prompt);
    }

    const onProgress = options.onProgress ?? null;
    if (onProgress) {
      onProgress("Starting OpenCode task.");
    }

    const child = spawn("opencode", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (onProgress) {
        const lastLine = text.trim().split(/\r?\n/).pop();
        if (lastLine) {
          onProgress(lastLine);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      // Try to extract session ID from output.
      // OpenCode may print session info; we parse it if available.
      const sessionId = extractSessionId(stdout) ?? extractSessionId(stderr) ?? null;

      resolve({
        status: code ?? 1,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        sessionId
      });
    });
  });
}

/**
 * Try to extract an OpenCode session ID from output text.
 * Looks for patterns like "Session: <id>" or "session_id: <id>".
 * @param {string} text
 * @returns {string|null}
 */
function extractSessionId(text) {
  // opencode prints session info in various formats
  const patterns = [
    /session[_\s-]*(?:id)?[:\s]+([a-zA-Z0-9_-]{8,})/i,
    /Resuming session[:\s]+([a-zA-Z0-9_-]{8,})/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/**
 * Kill an opencode process by PID.
 * @param {number} pid
 */
export function killOpenCodeProcess(pid) {
  if (!Number.isFinite(pid)) {
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}
