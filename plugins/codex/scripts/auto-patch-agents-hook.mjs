#!/usr/bin/env node
/**
 * SessionStart hook: auto-patch agents with OpenAI models.
 *
 * Scans ~/.claude/agents/*.md — if any has an OpenAI model value
 * (not haiku/sonnet/opus/inherit), converts it to haiku + codex forwarder.
 *
 * Runs on every session start to catch model changes made via /agents UI.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const AGENTS_DIR = path.join(process.env.HOME, ".claude", "agents");
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_MODELS = new Set(["haiku", "sonnet", "opus", "inherit", "best", "sonnet[1m]", "opus[1m]", "opusplan"]);
const BACKUP_SUFFIX = ".codex-backup";

function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; process.stdin.removeAllListeners(); process.stdin.destroy(); resolve(Buffer.concat(chunks).toString("utf-8")); }
    }, timeoutMs);
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => { if (!settled) { settled = true; clearTimeout(timeout); resolve(Buffer.concat(chunks).toString("utf-8")); } });
    process.stdin.on("error", () => { if (!settled) { settled = true; clearTimeout(timeout); resolve(""); } });
    if (process.stdin.readableEnded && !settled) { settled = true; clearTimeout(timeout); resolve(Buffer.concat(chunks).toString("utf-8")); }
  });
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { fields, body: match[2], raw: match[1] };
}

function isOpenAIModel(model) {
  if (!model) return false;
  // Strip YAML quotes before checking
  const clean = model.replace(/^["']|["']$/g, "").toLowerCase();
  return !CLAUDE_MODELS.has(clean);
}

async function main() {
  await readStdin(); // consume hook input

  if (!fs.existsSync(AGENTS_DIR)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith(".md") && !f.includes(BACKUP_SUFFIX));
  let patched = 0;

  for (const file of files) {
    const filePath = path.join(AGENTS_DIR, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = parseFrontmatter(content);
    if (!parsed) continue;

    const { fields, body } = parsed;
    const model = fields.model;

    // Skip if already patched (has _codex_model) or not an OpenAI model
    if (fields._codex_model || !isOpenAIModel(model)) continue;

    // This agent has an OpenAI model but no _codex_model — needs patching
    // Use patch-agents.mjs which handles backup + frontmatter preservation
    const codexModel = model;
    const agentName = file.replace(".md", "");

    try {
      const patchScript = path.join(SCRIPT_DIR, "patch-agents.mjs");
      execFileSync(process.execPath, [patchScript, "patch", agentName, codexModel], { timeout: 5000 });
      patched++;
    } catch { /* skip on error */ }
  }

  if (patched > 0) {
    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `[CODEX] Auto-patched ${patched} agent(s) with OpenAI models to use Codex forwarder.`
      }
    }));
  } else {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
});
