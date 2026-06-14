import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { loadPromptTemplate } from "../plugins/codex/scripts/lib/prompts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

// Job (a): design critique. Codex is a second model family used to critique a DESIGN with full
// read access to the code AND the live database — before the design is built.
test("critique command forwards to the codex-critique subagent and stays read-only", () => {
  const command = read("commands/critique.md");
  assert.match(command, /subagent_type: "codex:codex-critique"/);
  assert.match(command, /do not call `Skill\(codex:codex-critique\)`/i);
  assert.match(command, /allowed-tools:\s*Bash\(node:\*\),\s*Agent/);
  assert.match(command, /critiquing a DESIGN before it is built/i);
  assert.match(command, /default to background/i);
  assert.match(command, /--focus/);
  assert.match(command, /The final user-visible response must be Codex's output verbatim/i);
});

test("codex-critique agent is a thin forwarder to `critique` that never writes", () => {
  const agent = read("agents/codex-critique.md");
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /codex-companion\.mjs" critique \.\.\./);
  assert.match(agent, /READ-ONLY by design/i);
  assert.match(agent, /Never add `--write`/i);
  // It must NOT do its own analysis — independence is the whole point.
  assert.match(agent, /Do not reshape, summarize, or pre-analyze the design yourself/i);
  assert.match(agent, /Return the stdout of the `codex-companion` command exactly as-is/i);
  assert.match(agent, /codex-cli-runtime/);
});

test("the design-critique prompt mandates grounding in BOTH the code and the live database", () => {
  const prompt = read("prompts/design-critique.md");
  assert.match(prompt, /SECOND model family/);
  assert.match(prompt, /echoing its conclusions is worthless/i);
  // The database-grounding mandate is the thing that makes this critique better than prose-only.
  assert.match(prompt, /LIVE data/i);
  assert.match(prompt, /Query the database/i);
  assert.match(prompt, /Cite the query and its result/i);
  assert.match(prompt, /file:line/);
  assert.match(prompt, /\{\{DESIGN_INPUT\}\}/);
  assert.match(prompt, /\{\{USER_FOCUS\}\}/);
});

test("the companion exposes a read-only `critique` entrypoint", () => {
  const companion = read("scripts/codex-companion.mjs");
  assert.match(companion, /case "critique":/);
  assert.match(companion, /async function handleCritique\(argv\)/);
  assert.match(companion, /loadPromptTemplate\(ROOT_DIR, "design-critique"\)/);
  // handleCritique must run write:false (a critique never edits).
  assert.doesNotMatch(companion, /handleCritique[\s\S]*?write:\s*true/);
});

// The overlay seam: house conventions ride ON TOP of upstream prompts so `git pull upstream`
// never conflicts on the prompt scaffold. This is the durable "make it like us" mechanism.
test("the prompt overlay seam appends house conventions only when an overlay exists", () => {
  // adversarial-review HAS an overlay -> house_conventions block is appended.
  const reviewed = loadPromptTemplate(PLUGIN_ROOT, "adversarial-review");
  assert.match(reviewed, /<house_conventions>/);
  assert.match(reviewed, /SECOND model family/);
  assert.match(reviewed, /CONTRADICT, not echo/i);

  // design-critique has NO overlay -> no house_conventions wrapper is added.
  const critique = loadPromptTemplate(PLUGIN_ROOT, "design-critique");
  assert.doesNotMatch(critique, /<house_conventions>/);
});

// Job (b): code review on completed work. The house review rubric is carried by the overlay.
test("the adversarial-review overlay carries the house code-review rubric", () => {
  const overlay = read("prompts/overlays/adversarial-review.md");
  assert.match(overlay, /SECOND model family/);
  assert.match(overlay, /CONTRADICT, not echo/i);
  assert.match(overlay, /correctness and regressions first/i);
  assert.match(overlay, /file:line/);
  assert.match(overlay, /scripts\/check\.sh/);
  assert.match(overlay, /Scope discipline/i);
});

// Robustness: a turn that never completes would hang the worker forever (pid stays alive, so the
// liveness-reconcile can't catch it). A wall-clock turn timeout interrupts and fails it instead.
test("captureTurn has a wall-clock turn timeout that interrupts the stuck turn", () => {
  const codex = read("scripts/lib/codex.mjs");
  assert.match(codex, /CODEX_TURN_TIMEOUT_MS/);
  assert.match(codex, /function resolveTurnTimeoutMs/);
  assert.match(codex, /Promise\.race\(\[state\.completion, timeout\]\)/);
  assert.match(codex, /turn\/interrupt/);
});
