#!/usr/bin/env node
/**
 * Interactive Agent Model Configuration TUI
 *
 * Mimics Claude Code's /agents UI:
 * - Grouped by source (User agents, Plugin agents, etc.)
 * - Wrap-around ↑↓ navigation
 * - Enter to select → model picker
 * - q to quit
 *
 * Uses TTY hack: finds parent TTY + C input proxy for exclusive keyboard capture.
 */

import fs from "node:fs";
import path from "node:path";
import tty from "node:tty";
import { execSync, execFileSync, spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_MODELS = ["haiku", "sonnet", "opus"];
const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);

function getCodexModels() {
  try {
    const out = execSync(`node "${path.join(SCRIPT_DIR, 'patch-agents.mjs')}" available-models --json`, { encoding: "utf-8", timeout: 5000 });
    return (JSON.parse(out).codex || []).map(m => m.id);
  } catch { return []; }
}

function loadAgents() {
  try {
    const out = execSync(`node "${path.join(SCRIPT_DIR, 'patch-agents.mjs')}" list --json`, { encoding: "utf-8", timeout: 10000 });
    return JSON.parse(out);
  } catch { return []; }
}

const CODEX_MODELS = getCodexModels();
const ALL_MODELS = [...CLAUDE_MODELS, ...CODEX_MODELS];

// Source display order (matches /agents)
const SOURCE_ORDER = ["user", "omc:oh-my-claudecode", "openai-codex:codex", "claude-inspect:claude-inspect"];
const SOURCE_LABELS = {
  "user": "User agents",
  "omc:oh-my-claudecode": "Plugin agents (OMC)",
  "openai-codex:codex": "Plugin agents (Codex)",
  "claude-inspect:claude-inspect": "Plugin agents (Inspect)",
};

// ---------------------------------------------------------------------------
// TTY access
// ---------------------------------------------------------------------------

function findParentTTY() {
  try {
    let pid = process.ppid;
    for (let i = 0; i < 10; i++) {
      const ttyName = execSync(`ps -o tty= -p ${pid} 2>/dev/null`, { encoding: "utf-8" }).trim();
      if (ttyName && ttyName !== "??" && ttyName !== "?") {
        const dev = ttyName.startsWith("/dev/") ? ttyName : `/dev/${ttyName}`;
        if (fs.existsSync(dev)) return dev;
      }
      const ppid = execSync(`ps -o ppid= -p ${pid} 2>/dev/null`, { encoding: "utf-8" }).trim();
      if (!ppid || ppid === "0" || ppid === "1") break;
      pid = parseInt(ppid);
    }
  } catch {}
  return null;
}

function openTTY() {
  if (process.stdin.isTTY) {
    return { input: process.stdin, output: process.stdout, cleanup: () => {}, proxy: null };
  }

  const ttyPath = findParentTTY();
  if (!ttyPath) {
    console.error("Could not find a TTY.");
    process.exit(1);
  }

  const outFd = fs.openSync(ttyPath, "w");
  const output = new tty.WriteStream(outFd);

  // Auto-compile input proxy if needed
  let proxyPath = path.join(SCRIPT_DIR, "input_proxy");
  if (!fs.existsSync(proxyPath)) {
    const srcPath = proxyPath + ".c";
    if (fs.existsSync(srcPath)) {
      try { execSync(`cc -o "${proxyPath}" "${srcPath}"`, { timeout: 10000 }); } catch {}
    }
  }

  let input, proxy = null;
  if (fs.existsSync(proxyPath)) {
    proxy = spawn(proxyPath, [ttyPath], { stdio: ["ignore", "pipe", "ignore"] });
    input = proxy.stdout;
  } else {
    const inFd = fs.openSync(ttyPath, "r");
    input = new tty.ReadStream(inFd);
  }

  return {
    input, output, proxy,
    cleanup: () => {
      if (proxy) { try { proxy.kill("SIGTERM"); } catch {} }
      try { output.destroy(); } catch {}
      try { fs.closeSync(outFd); } catch {}
    }
  };
}

// ---------------------------------------------------------------------------
// ANSI
// ---------------------------------------------------------------------------

const E = "\x1b";
const HIDE_CURSOR = `${E}[?25l`;
const SHOW_CURSOR = `${E}[?25h`;
const BOLD = `${E}[1m`;
const DIM = `${E}[2m`;
const RESET = `${E}[0m`;
const CYAN = `${E}[36m`;
const GREEN = `${E}[32m`;
const YELLOW = `${E}[33m`;
const MAGENTA = `${E}[35m`;
const INVERSE = `${E}[7m`;
const CLEAR_EOL = `${E}[K`;

function mcolor(model) {
  if (CODEX_MODELS.includes(model)) return GREEN;
  if (model === "opus") return MAGENTA;
  if (model === "sonnet") return CYAN;
  return YELLOW;
}

// ---------------------------------------------------------------------------
// TUI
// ---------------------------------------------------------------------------

class TUI {
  constructor(input, output, cleanup, proxy) {
    this.input = input;
    this.output = output;
    this.cleanup = cleanup;
    this.proxy = proxy;
    this.running = true;
    this.mode = "list"; // "list" | "model"
    this.changes = {};
    this.selectedAgent = null;
    this.modelCursor = 0;
    this.rows = output.rows || 24;
    this.cols = output.columns || 80;

    // Build grouped flat list (matches /agents source order)
    const raw = loadAgents();
    this.items = []; // { type: "header"|"agent", ... }
    const bySource = new Map();
    for (const a of raw) {
      const s = a.source || "user";
      if (!bySource.has(s)) bySource.set(s, []);
      bySource.get(s).push(a);
    }

    for (const src of SOURCE_ORDER) {
      const agents = bySource.get(src);
      if (!agents || !agents.length) continue;
      this.items.push({ type: "header", label: SOURCE_LABELS[src] || src, source: src });
      for (const a of agents) {
        this.items.push({ type: "agent", ...a });
      }
      bySource.delete(src);
    }
    // Any remaining sources
    for (const [src, agents] of bySource) {
      if (!agents.length) continue;
      this.items.push({ type: "header", label: SOURCE_LABELS[src] || src, source: src });
      for (const a of agents) {
        this.items.push({ type: "agent", ...a });
      }
    }

    // Navigation cursor — only on agent items
    this.cursor = 0;
    this.agentIndices = this.items.map((it, i) => it.type === "agent" ? i : -1).filter(i => i >= 0);
    this.navPos = 0; // index into agentIndices
    this.scroll = 0;
  }

  start() {
    if (this.input.setRawMode) this.input.setRawMode(true);
    this.input.resume();
    this.input.setEncoding("utf-8");
    this.write(HIDE_CURSOR);

    this.input.on("data", (key) => {
      if (!this.running) return;
      if (key === "\x03") return this.quit();
      if (this.mode === "list") this.handleList(key);
      else this.handleModel(key);
      this.render();
    });

    this.render();
    this._interval = setInterval(() => { if (this.running) this.render(); }, 33);
  }

  write(s) { this.output.write(s); }

  handleList(key) {
    const total = this.agentIndices.length;
    if (!total) return;

    if (key === "\x1b[A" || key === "k") {
      // Wrap-around up
      this.navPos = this.navPos === 0 ? total - 1 : this.navPos - 1;
    } else if (key === "\x1b[B" || key === "j") {
      // Wrap-around down
      this.navPos = this.navPos === total - 1 ? 0 : this.navPos + 1;
    } else if (key === "\r") {
      const idx = this.agentIndices[this.navPos];
      this.selectedAgent = this.items[idx];
      const curModel = this.selectedAgent.currentModel || "sonnet";
      this.modelCursor = ALL_MODELS.indexOf(curModel);
      if (this.modelCursor === -1) this.modelCursor = 0;
      this.mode = "model";
    } else if (key === "q") {
      this.quit();
    }

    // Adjust scroll
    this.adjustScroll();
  }

  adjustScroll() {
    const visible = this.rows - 4;
    const targetLine = this.agentIndices[this.navPos];
    if (targetLine < this.scroll) this.scroll = targetLine;
    if (targetLine >= this.scroll + visible) this.scroll = targetLine - visible + 1;
    if (this.scroll < 0) this.scroll = 0;
  }

  handleModel(key) {
    if (key === "\x1b[A" || key === "k") {
      this.modelCursor = this.modelCursor === 0 ? ALL_MODELS.length - 1 : this.modelCursor - 1;
    } else if (key === "\x1b[B" || key === "j") {
      this.modelCursor = this.modelCursor === ALL_MODELS.length - 1 ? 0 : this.modelCursor + 1;
    } else if (key === "\r") {
      const m = ALL_MODELS[this.modelCursor];
      const a = this.selectedAgent;
      if (m !== a.currentModel) {
        this.changes[a.filePath] = { name: a.name, model: m };
        a.currentModel = m;
        a.isCodex = CODEX_MODELS.includes(m);
      }
      this.mode = "list";
    } else if (key === "b" || key === "\x1b") {
      this.mode = "list";
    }
  }

  render() {
    const { rows, cols } = this;
    let out = `${E}[H`; // cursor home
    if (this.mode === "list") out += this.renderList(rows, cols);
    else out += this.renderModel(rows, cols);
    out += `${E}[J`; // clear below
    this.write(out);
  }

  renderList(rows, cols) {
    const cc = Object.keys(this.changes).length;
    const visible = rows - 4;
    const selectedIdx = this.agentIndices[this.navPos];

    let o = `${BOLD} Codex Agent Config ${RESET}`;
    if (cc > 0) o += ` ${GREEN}${cc} change(s)${RESET}`;
    o += `${CLEAR_EOL}\n`;
    o += `${DIM} ↑↓ Navigate · Enter Select · q Quit & Apply${RESET}${CLEAR_EOL}\n`;
    o += `${DIM}${"─".repeat(Math.min(cols - 1, 70))}${RESET}${CLEAR_EOL}\n`;

    const end = Math.min(this.scroll + visible, this.items.length);
    for (let i = this.scroll; i < end; i++) {
      const item = this.items[i];
      if (item.type === "header") {
        o += `${CLEAR_EOL}\n`;
        o += `  ${BOLD}${DIM}${item.label}:${RESET}${CLEAR_EOL}\n`;
      } else {
        const sel = i === selectedIdx;
        const mc = mcolor(item.currentModel);
        const model = `${mc}${item.currentModel}${RESET}`;
        const changed = this.changes[item.filePath] ? ` ${GREEN}*${RESET}` : "";

        if (sel) {
          o += `${INVERSE} ❯ ${item.name.padEnd(30)} ${item.currentModel.padEnd(18)} ${RESET}${changed}${CLEAR_EOL}\n`;
        } else {
          o += `   ${item.name.padEnd(30)} ${model}${"".padEnd(Math.max(0, 18 - item.currentModel.length))}${changed}${CLEAR_EOL}\n`;
        }
      }
    }

    // Status
    const total = this.agentIndices.length;
    const pct = total > 0 ? Math.round(((this.navPos + 1) / total) * 100) : 0;
    o += `${CLEAR_EOL}\n${DIM} ${this.navPos + 1}/${total} (${pct}%)${RESET}${CLEAR_EOL}`;

    // Fill rest
    const usedLines = 3 + (end - this.scroll) + 2;
    for (let i = usedLines; i < rows; i++) o += `${CLEAR_EOL}\n`;
    return o;
  }

  renderModel(rows, cols) {
    const a = this.selectedAgent;
    let o = `${BOLD} Select model: ${CYAN}${a.name}${RESET} ${DIM}[${a.source}]${RESET}${CLEAR_EOL}\n`;
    o += `${DIM} ↑↓ Navigate · Enter Confirm · b/Esc Back${RESET}${CLEAR_EOL}\n`;
    o += `${DIM}${"─".repeat(Math.min(cols - 1, 50))}${RESET}${CLEAR_EOL}\n`;

    o += `${CLEAR_EOL}\n`;
    o += `  ${BOLD}${DIM}Anthropic:${RESET}${CLEAR_EOL}\n`;
    for (let i = 0; i < CLAUDE_MODELS.length; i++) {
      const m = CLAUDE_MODELS[i];
      const sel = this.modelCursor === i;
      const cur = m === a.currentModel ? ` ${DIM}(current)${RESET}` : "";
      if (sel) o += ` ${INVERSE} ❯ ${m} ${RESET}${cur}${CLEAR_EOL}\n`;
      else o += `   ${mcolor(m)}${m}${RESET}${cur}${CLEAR_EOL}\n`;
    }

    o += `${CLEAR_EOL}\n`;
    o += `  ${BOLD}${DIM}OpenAI (via Codex):${RESET}${CLEAR_EOL}\n`;
    for (let i = 0; i < CODEX_MODELS.length; i++) {
      const mi = CLAUDE_MODELS.length + i;
      const m = CODEX_MODELS[i];
      const sel = this.modelCursor === mi;
      const cur = m === a.currentModel ? ` ${DIM}(current)${RESET}` : "";
      if (sel) o += ` ${INVERSE} ❯ ${m} ${RESET}${cur}${CLEAR_EOL}\n`;
      else o += `   ${GREEN}${m}${RESET}${cur}${CLEAR_EOL}\n`;
    }

    // Fill rest
    const usedLines = 3 + 2 + CLAUDE_MODELS.length + 2 + CODEX_MODELS.length;
    for (let i = usedLines; i < rows; i++) o += `${CLEAR_EOL}\n`;
    return o;
  }

  quit() {
    this.running = false;
    if (this._interval) clearInterval(this._interval);

    // Kill proxy first — restores Claude Code as foreground
    if (this.proxy) {
      try { this.proxy.kill("SIGTERM"); } catch {}
      try { execSync("sleep 0.2"); } catch {}
    }
    try { if (this.input.setRawMode) this.input.setRawMode(false); } catch {}
    this.write(SHOW_CURSOR + `${E}[2J${E}[H`);

    // Apply changes
    const entries = Object.entries(this.changes);
    if (!entries.length) {
      console.log("No changes made.");
    } else {
      const patchScript = path.join(SCRIPT_DIR, "patch-agents.mjs");
      for (const [filePath, { name, model }] of entries) {
        try {
          execFileSync(process.execPath, [patchScript, "patch", filePath, model], { encoding: "utf-8", timeout: 5000 });
          const prov = CODEX_MODELS.includes(model) ? "OpenAI" : "Anthropic";
          console.log(`  ${name} → ${model} (${prov}) ✓`);
        } catch (e) {
          console.log(`  ${name} → ${model} FAILED`);
        }
      }
      console.log(`\n${entries.length} agent(s) updated.`);
    }

    this.cleanup();
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { input, output, cleanup, proxy } = openTTY();
new TUI(input, output, cleanup, proxy).start();
