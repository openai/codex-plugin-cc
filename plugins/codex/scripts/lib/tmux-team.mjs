/**
 * Tmux-based multi-agent pane management for Codex agent teams.
 *
 * Creates split panes in the current tmux window, launches Codex instances,
 * and provides send/capture primitives for coordinating parallel agents.
 * Follows the same pane layout strategy as Claude Code's TmuxBackend:
 * the leader (Claude Code) stays in the left 30%, agents fill the right 70%
 * with alternating horizontal and vertical splits.
 */

import { spawnSync } from "node:child_process";

const TMUX = "tmux";
const SHELL_INIT_DELAY_MS = 200;
const CODEX_BOOT_DELAY_MS = 8000;
const CODEX_COMMAND = "codex --dangerously-bypass-approvals-and-sandbox";

/** Single-quote a value for safe shell interpolation. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Tmux color names matching Claude Code's TmuxBackend color scheme.
 * Up to 8 agents can have distinct border colors.
 * @type {Array<{ name: string, tmux: string }>}
 */
const AGENT_COLORS = [
  { name: "red", tmux: "red" },
  { name: "blue", tmux: "blue" },
  { name: "green", tmux: "green" },
  { name: "yellow", tmux: "yellow" },
  { name: "purple", tmux: "magenta" },
  { name: "orange", tmux: "colour208" },
  { name: "pink", tmux: "colour205" },
  { name: "cyan", tmux: "cyan" }
];

/**
 * @typedef {{
 *   name: string,
 *   paneId: string,
 *   color: string,
 *   tmuxColor: string,
 *   index: number
 * }} AgentInfo
 */

/**
 * @typedef {{
 *   leaderPaneId: string,
 *   windowTarget: string,
 *   agents: AgentInfo[],
 *   cwd: string
 * }} AgentTeamResult
 */

// ---------------------------------------------------------------------------
// Low-level tmux helpers
// ---------------------------------------------------------------------------

/** @returns {{ stdout: string, stderr: string, code: number }} */
function tmux(args) {
  const result = spawnSync(TMUX, args, { encoding: "utf8", timeout: 5000 });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status ?? 1
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tmux environment detection
// ---------------------------------------------------------------------------

/** Checks whether the tmux binary is available on PATH. */
export function isTmuxAvailable() {
  return spawnSync(TMUX, ["-V"], { encoding: "utf8", timeout: 3000 }).status === 0;
}

/** Checks whether the current process is running inside a tmux session. */
export function isInsideTmux() {
  return Boolean(process.env.TMUX);
}

// ---------------------------------------------------------------------------
// Window and pane queries
// ---------------------------------------------------------------------------

/**
 * Returns the current tmux pane ID.
 * Prefers the TMUX_PANE env var captured at process start so the leader's
 * pane is always identified even if the user switches focus.
 */
function getCurrentPaneId() {
  if (process.env.TMUX_PANE) {
    return process.env.TMUX_PANE;
  }
  const result = tmux(["display-message", "-p", "#{pane_id}"]);
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * Returns the current tmux session:window target, queried relative to the
 * leader pane so that focus changes do not affect the result.
 */
function getCurrentWindowTarget() {
  const paneId = getCurrentPaneId();
  const args = ["display-message"];
  if (paneId) {
    args.push("-t", paneId);
  }
  args.push("-p", "#{session_name}:#{window_index}");
  const result = tmux(args);
  return result.code === 0 ? result.stdout.trim() : null;
}

/** Returns pane IDs for a given window target. */
function listPaneIds(windowTarget) {
  const result = tmux(["list-panes", "-t", windowTarget, "-F", "#{pane_id}"]);
  if (result.code !== 0) {
    return [];
  }
  return result.stdout.trim().split("\n").filter(Boolean);
}

// ---------------------------------------------------------------------------
// Pane styling (border color + title)
// ---------------------------------------------------------------------------

/** Sets the border color for a pane (requires tmux 3.2+). */
function setPaneBorderColor(paneId, tmuxColor) {
  tmux(["select-pane", "-t", paneId, "-P", `bg=default,fg=${tmuxColor}`]);
  tmux(["set-option", "-p", "-t", paneId, "pane-border-style", `fg=${tmuxColor}`]);
  tmux(["set-option", "-p", "-t", paneId, "pane-active-border-style", `fg=${tmuxColor}`]);
}

/** Sets the title for a pane, shown in the pane border. */
function setPaneTitle(paneId, name, tmuxColor) {
  tmux(["select-pane", "-t", paneId, "-T", name]);
  tmux([
    "set-option", "-p", "-t", paneId, "pane-border-format",
    `#[fg=${tmuxColor},bold] #{pane_title} #[default]`
  ]);
}

/** Enables pane border status on a window so pane titles are visible. */
function enablePaneBorderStatus(windowTarget) {
  tmux(["set-option", "-w", "-t", windowTarget, "pane-border-status", "top"]);
}

// ---------------------------------------------------------------------------
// Layout rebalancing
// ---------------------------------------------------------------------------

/**
 * Rebalances the leader pane to 30% width and lets agents share the
 * remaining 70%. Only touches the leader pane we created — other panes
 * in the window are left untouched.
 */
function rebalancePanes(leaderPaneId, agentPaneIds) {
  if (agentPaneIds.length === 0) {
    return;
  }
  tmux(["resize-pane", "-t", leaderPaneId, "-x", "30%"]);
}

// ---------------------------------------------------------------------------
// Pane creation
// ---------------------------------------------------------------------------

/**
 * Creates a single agent pane using the TmuxBackend split strategy.
 *
 * First agent: horizontal split from the leader pane, taking 70% width.
 * Additional agents: alternating vertical and horizontal splits from
 * existing agent panes, keeping the layout balanced.
 */
function createAgentPane(leaderPaneId, windowTarget, name, color, agentPanes) {
  const isFirst = agentPanes.length === 0;

  let result;
  if (isFirst) {
    result = tmux([
      "split-window", "-t", leaderPaneId, "-h", "-l", "70%",
      "-P", "-F", "#{pane_id}"
    ]);
  } else {
    const count = agentPanes.length;
    const splitVertically = count % 2 === 1;
    const targetIndex = Math.floor((count - 1) / 2);
    const targetPane = agentPanes[targetIndex] || agentPanes[agentPanes.length - 1];
    result = tmux([
      "split-window", "-t", targetPane, splitVertically ? "-v" : "-h",
      "-P", "-F", "#{pane_id}"
    ]);
  }

  if (result.code !== 0) {
    throw new Error(`Failed to create pane for ${name}: ${result.stderr.trim()}`);
  }

  const paneId = result.stdout.trim();
  setPaneBorderColor(paneId, color.tmux);
  setPaneTitle(paneId, name, color.tmux);

  if (isFirst) {
    enablePaneBorderStatus(windowTarget);
  }

  return paneId;
}

// ---------------------------------------------------------------------------
// Public API: agent lifecycle
// ---------------------------------------------------------------------------

/**
 * Sends text to an agent pane followed by Enter.
 * @param {string} paneId
 * @param {string} text
 */
export function sendToAgent(paneId, text) {
  const result = tmux(["send-keys", "-t", paneId, text, "Enter"]);
  if (result.code !== 0) {
    throw new Error(`Failed to send to pane ${paneId}: ${result.stderr.trim()}`);
  }
}

/**
 * Captures recent scrollback from an agent pane.
 * @param {string} paneId
 * @param {number} [lines=80]
 * @returns {string}
 */
export function captureAgentOutput(paneId, lines = 80) {
  const result = tmux(["capture-pane", "-t", paneId, "-p", "-S", `-${lines}`]);
  return result.code === 0 ? result.stdout : "";
}

/**
 * Kills a single agent pane.
 * @param {string} paneId
 * @returns {boolean} True if the pane was killed.
 */
export function killAgent(paneId) {
  return tmux(["kill-pane", "-t", paneId]).code === 0;
}

/**
 * Kills all agent panes in the given list.
 * @param {string[]} paneIds
 * @returns {number} Count of panes successfully killed.
 */
export function killAllAgents(paneIds) {
  let killed = 0;
  for (const paneId of paneIds) {
    if (killAgent(paneId)) {
      killed += 1;
    }
  }
  return killed;
}

/**
 * Checks whether a tmux pane is still alive.
 * @param {string} paneId
 * @returns {boolean}
 */
export function isPaneAlive(paneId) {
  return tmux(["display-message", "-t", paneId, "-p", "#{pane_id}"]).code === 0;
}

/**
 * Spawns N Codex agents in tmux split panes.
 *
 * Each agent gets its own pane with a colored border and title, and has
 * `codex --dangerously-bypass-approvals-and-sandbox` launched inside it.
 * Returns metadata for each agent so the caller can send tasks and
 * capture output via the pane IDs.
 *
 * @param {number} count - Number of agents to spawn (clamped to 1-8).
 * @param {{ cwd?: string, names?: string[] }} [options]
 * @returns {Promise<AgentTeamResult>}
 */
export async function spawnAgentTeam(count, options = {}) {
  if (!isTmuxAvailable()) {
    throw new Error("tmux is not installed. Install it with `brew install tmux`.");
  }
  if (!isInsideTmux()) {
    throw new Error("agent-team requires running inside a tmux session. Start tmux first.");
  }

  const leaderPaneId = getCurrentPaneId();
  const windowTarget = getCurrentWindowTarget();
  if (!leaderPaneId || !windowTarget) {
    throw new Error("Could not detect current tmux pane or window.");
  }

  const cwd = options.cwd || process.cwd();
  const max = AGENT_COLORS.length;
  const safeCount = Math.max(1, Math.min(max, count));
  const agents = [];

  const agentPaneIds = [];

  for (let i = 0; i < safeCount; i++) {
    const name = options.names?.[i] || `codex-${i + 1}`;
    const color = AGENT_COLORS[i % max];

    const paneId = createAgentPane(leaderPaneId, windowTarget, name, color, agentPaneIds);
    agentPaneIds.push(paneId);
    await sleep(SHELL_INIT_DELAY_MS);

    sendToAgent(paneId, `cd ${shellQuote(cwd)} && ${CODEX_COMMAND}`);

    agents.push({ name, paneId, color: color.name, tmuxColor: color.tmux, index: i });
  }

  rebalancePanes(leaderPaneId, agentPaneIds);

  // Wait for Codex to boot in all panes, then send a confirmation Enter
  // to each one so the prompt is ready to accept tasks. Matches the
  // sleep-then-Enter pattern from /ship-it and /tmux.
  await sleep(CODEX_BOOT_DELAY_MS);
  for (const agent of agents) {
    tmux(["send-keys", "-t", agent.paneId, "", "Enter"]);
  }

  return { leaderPaneId, windowTarget, agents, cwd };
}

export { AGENT_COLORS };
