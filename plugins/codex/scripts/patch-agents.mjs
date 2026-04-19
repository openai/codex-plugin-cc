#!/usr/bin/env node
/**
 * Agent Model Patcher
 *
 * Patches ~/.claude/agents/*.md to use Codex (OpenAI) models
 * or switch between Claude models.
 *
 * Commands:
 *   list [--json]                  List agents with current model
 *   available-models [--json]      List available models
 *   patch <name> <model>           Patch agent to use specified model
 *   restore-all                    Restore all codex-patched agents to original model
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const AGENTS_DIR = path.join(process.env.HOME, ".claude", "agents");
const PLUGINS_DIR = path.join(process.env.HOME, ".claude", "plugins", "cache");

function findAllAgentDirs() {
  const dirs = [{ dir: AGENTS_DIR, source: "user" }];
  // Scan plugin cache for agent directories
  if (fs.existsSync(PLUGINS_DIR)) {
    try {
      for (const marketplace of fs.readdirSync(PLUGINS_DIR)) {
        const mDir = path.join(PLUGINS_DIR, marketplace);
        for (const plugin of fs.readdirSync(mDir)) {
          const pDir = path.join(mDir, plugin);
          // Find latest version
          const versions = fs.readdirSync(pDir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
          const latest = versions[versions.length - 1];
          if (!latest) continue;
          const agentsDir = path.join(pDir, latest, "agents");
          if (fs.existsSync(agentsDir)) {
            dirs.push({ dir: agentsDir, source: `${marketplace}:${plugin}` });
          }
        }
      }
    } catch { /* noop */ }
  }
  return dirs;
}
const CLAUDE_MODELS = ["haiku", "sonnet", "opus"];

function getCodexModels() {
  const companionPath = findCodexCompanion();
  const models = new Set();

  // Read model aliases from codex-companion
  if (companionPath) {
    try {
      const src = fs.readFileSync(companionPath, "utf-8");
      const match = src.match(/MODEL_ALIASES\s*=\s*new Map\(\[(.*?)\]\)/s);
      if (match) {
        for (const m of match[1].matchAll(/"([^"]+)"\s*,\s*"([^"]+)"/g)) {
          models.add(m[2]); // add the full model name
        }
      }
    } catch { /* noop */ }
  }

  // Read default model from codex config
  try {
    const toml = fs.readFileSync(path.join(process.env.HOME, ".codex", "config.toml"), "utf-8");
    const modelMatch = toml.match(/^model\s*=\s*"([^"]+)"/m);
    if (modelMatch) models.add(modelMatch[1]);
  } catch { /* noop */ }

  return [...models];
}

const CODEX_MODELS = getCodexModels();

const CODEX_COMPANION_PATH = findCodexCompanion();

function findCodexCompanion() {
  const cacheDir = path.join(process.env.HOME, ".claude/plugins/cache/openai-codex/codex");
  try {
    const versions = fs.readdirSync(cacheDir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const latest = versions[versions.length - 1];
    if (!latest) return null;
    const p = path.join(cacheDir, latest, "scripts", "codex-companion.mjs");
    return fs.existsSync(p) ? p : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { fields: {}, body: content, raw: "" };

  const raw = match[1];
  const body = match[2];
  const fields = {};

  let currentKey = null;
  for (const line of raw.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      // Indented continuation — append to current key (YAML list item)
      if (currentKey) {
        const item = line.trim().replace(/^-\s*/, "");
        fields[currentKey] = fields[currentKey] ? `${fields[currentKey]}, ${item}` : item;
      }
      continue;
    }
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    currentKey = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    fields[currentKey] = value;
  }

  return { fields, body, raw };
}

function setField(raw, key, value) {
  // Replace top-level field + any indented continuation lines (YAML lists)
  const re = new RegExp(`^${key}:.*(?:\n(?=[ \t]).*)*`, "m");
  if (re.test(raw)) {
    return raw.replace(re, `${key}: ${value}`);
  }
  return raw + `\n${key}: ${value}`;
}

function removeField(raw, key) {
  // Remove field + any indented continuation lines + trailing newline (optional for last line)
  return raw.replace(new RegExp(`^${key}:.*(?:\n(?=[ \t]).*)*\r?\n?`, "m"), "").replace(/\n{2,}/g, "\n");
}

function rebuildFile(raw, body) {
  return `---\n${raw}\n---\n${body}`;
}

// ---------------------------------------------------------------------------
// Agent file helpers
// ---------------------------------------------------------------------------

function listAllAgents() {
  const all = [];
  for (const { dir, source } of findAllAgentDirs()) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md") || f.includes(".codex-backup") || f.includes(".bak")) continue;
      const name = f.replace(".md", "");
      const filePath = path.join(dir, f);
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = parseFrontmatter(content);
      all.push({ name, filePath, source, content, ...parsed });
    }
  }
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

function readAgent(name) {
  // Search all agent dirs, prefer user agents
  const allDirs = findAllAgentDirs();
  let found = null;
  for (const { dir, source } of allDirs) {
    const filePath = path.join(dir, `${name}.md`);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      found = { filePath, source, content, ...parseFrontmatter(content) };
      if (source === "user") return found; // user takes priority
    }
  }
  return found;
}

function isCodexPatched(fields) {
  return Boolean(fields._codex_model);
}

function isCodexModel(model) {
  return !CLAUDE_MODELS.includes(model);
}

// ---------------------------------------------------------------------------
// Patch / Restore
// ---------------------------------------------------------------------------

/** Removes the injected Codex forwarder preamble from an agent body, leaving only the original role content. */
function stripCodexForwarder(body) {
  return body.replace(/^You are a thin forwarding wrapper[\s\S]*?Role context[^\n]*\n/m, "");
}

function patchAgent(nameOrPath, targetModel) {
  let agent;
  if (nameOrPath.includes("/")) {
    // Direct path
    if (!fs.existsSync(nameOrPath)) throw new Error(`File not found: ${nameOrPath}`);
    const content = fs.readFileSync(nameOrPath, "utf-8");
    agent = { filePath: nameOrPath, content, ...parseFrontmatter(content) };
  } else {
    agent = readAgent(nameOrPath);
    if (!agent) throw new Error(`Agent "${nameOrPath}" not found`);
  }

  const { fields, body, raw, filePath } = agent;
  const name = fields.name || path.basename(filePath, ".md");
  const wasCodex = isCodexPatched(fields);
  const originalModel = fields._original_model || fields.model || "sonnet";
  // Strip any existing codex forwarder line from body
  const cleanBody = wasCodex ? stripCodexForwarder(body) : body;

  if (CLAUDE_MODELS.includes(targetModel)) {
    // Switching to Claude model — remove codex fields
    let newRaw = setField(raw, "model", targetModel);
    if (wasCodex) {
      newRaw = removeField(newRaw, "_codex_model");
      newRaw = removeField(newRaw, "tools");
    }
    if (fields.description) {
      newRaw = setField(newRaw, "description", fields.description.replace(/\s*\(Codex:.*?\)/, ""));
    }

    fs.writeFileSync(filePath, rebuildFile(newRaw, cleanBody), "utf-8");
    return { name, model: targetModel, type: "claude", action: "updated" };
  }

  // OpenAI model — set up as Codex forwarder
  if (!CODEX_COMPANION_PATH) {
    throw new Error("codex-plugin-cc not installed. Run /codex:setup first.");
  }

  const disallowed = (fields.disallowedTools || "").toLowerCase();
  const tools = (fields.tools || "").toLowerCase();
  // Read-only if Write/Edit explicitly disallowed, or if tools are listed but don't include Write/Edit
  const hasToolsList = tools.length > 0;
  const toolsAllowWrite = !hasToolsList || tools.includes("write") || tools.includes("edit");
  const readOnly = disallowed.includes("write") || disallowed.includes("edit") || !toolsAllowWrite;
  const writeFlag = readOnly ? "" : " --write";

  let newRaw = setField(raw, "model", "haiku");
  newRaw = setField(newRaw, "tools", "Bash");
  newRaw = setField(newRaw, "_codex_model", targetModel);
  const desc = (fields.description || "").replace(/\s*\(Codex:.*?\)/, "");
  newRaw = setField(newRaw, "description", `${desc} (Codex: ${targetModel})`);

  const newBody = `You are a thin forwarding wrapper around the Codex companion task runtime.

Your only job is to forward the user's request to the Codex companion script. Do not do anything else.

Selection guidance:

- Do not wait for the user to explicitly ask for Codex. Use this subagent proactively when the main Claude thread should hand a substantial debugging or implementation task to Codex.
- Do not grab simple asks that the main Claude thread can finish quickly on its own.

Forwarding rules:

- Use exactly one \`Bash\` call to invoke \`node "${CODEX_COMPANION_PATH}" task --model ${targetModel}${writeFlag} ...\`.
- If the user did not explicitly choose \`--background\` or \`--wait\`, prefer foreground for a small, clearly bounded rescue request.
- If the user did not explicitly choose \`--background\` or \`--wait\` and the task looks complicated, open-ended, multi-step, or likely to keep Codex running for a long time, prefer background execution.
- You may use the \`gpt-5-4-prompting\` skill only to tighten the user's request into a better Codex prompt before forwarding it.
- Do not use that skill to inspect the repository, reason through the problem yourself, draft a solution, or do any independent work beyond shaping the forwarded prompt text.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Do not call \`review\`, \`adversarial-review\`, \`status\`, \`result\`, or \`cancel\`. This subagent only forwards to \`task\`.
- Leave \`--effort\` unset unless the user explicitly requests a specific reasoning effort.
- Treat \`--effort <value>\` as a runtime control and do not include it in the task text you pass through.
- Default to a ${readOnly ? "read-only" : "write-capable"} Codex run${readOnly ? "" : " by adding \\`--write\\`"} unless the user explicitly asks otherwise.
- Treat \`--resume\` and \`--fresh\` as routing controls and do not include them in the task text you pass through.
- \`--resume\` means add \`--resume-last\`.
- \`--fresh\` means do not add \`--resume-last\`.
- If the user is clearly asking to continue prior Codex work in this repository, such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", add \`--resume-last\` unless \`--fresh\` is present.
- Otherwise forward the task as a fresh \`task\` run.
- Preserve the user's task text as-is apart from stripping routing flags.
- Include the role context below in the task text sent to Codex.
- Return the stdout of the \`codex-companion\` command exactly as-is.
- If the Bash call fails or Codex cannot be invoked, return nothing.

Response style:

- Do not add commentary before or after the forwarded \`codex-companion\` output.

Role context (include in the task text sent to Codex):
${cleanBody.trim()}
`;

  fs.writeFileSync(filePath, rebuildFile(newRaw, newBody), "utf-8");
  return { name, model: targetModel, type: "codex", action: "patched", originalModel };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function listAgents() {
  return listAllAgents().map(agent => {
    const { fields, name, source } = agent;
    const codexModel = fields._codex_model || null;
    const originalModel = fields._original_model || null;
    const currentModel = codexModel || fields.model || "sonnet";

    return {
      name,
      currentModel,
      source,
      filePath: agent.filePath,
      isCodex: Boolean(codexModel),
      originalModel,
    };
  }).filter(Boolean);
}

function listAvailableModels() {
  return {
    claude: CLAUDE_MODELS.map(m => ({ id: m, provider: "anthropic" })),
    codex: CODEX_MODELS.map(m => ({ id: m, provider: "openai" })),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const [command, ...args] = process.argv.slice(2);
  const json = args.includes("--json");
  const cleanArgs = args.filter(a => a !== "--json");

  try {
    let result;

    switch (command) {
      case "list":
        result = listAgents();
        break;

      case "available-models":
        result = listAvailableModels();
        break;

      case "patch": {
        const [nameOrPath, model] = cleanArgs;
        if (!nameOrPath || !model) throw new Error("Usage: patch <agent-name-or-path> <model>");
        result = patchAgent(nameOrPath, model);
        break;
      }

      default:
        console.error("Usage: patch-agents.mjs <list|available-models|patch> [args]");
        process.exitCode = 1;
        return;
    }

    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(JSON.stringify(result));
    }
  } catch (e) {
    if (json) {
      console.log(JSON.stringify({ error: e.message }));
    } else {
      console.error(e.message);
    }
    process.exitCode = 1;
  }
}

main();
