import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Codex review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support staged-only review, unstaged-only review, or extra focus text/i);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\] \[focus \.\.\.\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" adversarial-review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Codex adversarial review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /uses the same review target selection as `\/codex:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
});

test("codex-reviewer is a read-only native review forwarder", () => {
  const agent = read("agents/codex-reviewer.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(agent, /^name:\s*codex-reviewer$/m);
  assert.match(agent, /^tools:\s*Bash$/m);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /normal request[\s\S]*codex-companion\.mjs" review/);
  assert.match(agent, /focus text[\s\S]*codex-companion\.mjs" adversarial-review/);
  assert.match(agent, /foreground by default/i);
  assert.match(agent, /only.*background.*explicit/i);
  assert.match(agent, /stdout.*exactly as-is/i);
  assert.match(agent, /Never invoke task, never add --write/i);
  assert.match(agent, /never add --resume, --resume-last, or --resume-id/i);
  assert.doesNotMatch(agent, /codex-companion\.mjs" task/);
  assert.doesNotMatch(agent, /^skills:/m);
  assert.match(readme, /the `codex:codex-rescue` and `codex:codex-reviewer` subagents in `\/agents`/i);
});

test("continue is not exposed as a user-facing command", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transfer.md"
  ]);
});

test("internal GPT-5.6 routing policy defines fresh rescue tiers and safe fallbacks", () => {
  const routing = read("skills/gpt-5-6-routing/SKILL.md");

  assert.match(routing, /user-invocable:\s*false/);
  assert.match(routing, /gpt-5\.6-luna.*low/s);
  assert.match(routing, /gpt-5\.6-terra.*medium/s);
  assert.match(routing, /gpt-5\.6-sol.*high/s);
  assert.match(routing, /gpt-5\.6-sol.*xhigh/s);
  assert.match(routing, /ambiguous.*higher tier/i);
  assert.match(routing, /cannot decide.*leave.*unset/is);
  assert.match(routing, /max.*explicit-only/is);
  assert.match(routing, /Do not query a model catalog/i);
  assert.match(routing, /do not substitute fallback model names/i);
});

test("rescue command absorbs continue semantics", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/codex-rescue.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");

  assert.match(rescue, /The final user-visible response must be Codex's output verbatim/i);
  assert.match(rescue, /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion,\s*Agent/);
  // Regression for #234: `Skill(codex:rescue)` from the main agent recursed
  // because rescue.md named the routing with ambiguous prose ("Route this
  // request to the `codex:codex-rescue` subagent") while running under
  // `context: fork` — forked general-purpose subagents do not expose the
  // `Agent` tool, so the fork fell back to `Skill` and re-entered this
  // command. Pin the explicit transport and the inline (no-fork) execution.
  assert.match(rescue, /subagent_type: "codex:codex-rescue"/);
  assert.match(rescue, /do not call `Skill\(codex:codex-rescue\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--resume-id <thread-id>\|--fresh/);
  assert.match(rescue, /--model <model\|spark>/);
  assert.match(rescue, /--effort <none\|minimal\|low\|medium\|high\|xhigh\|max>/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(rescue, /Continue current Codex thread/);
  assert.match(rescue, /Start a new Codex thread/);
  assert.match(rescue, /run the `codex:codex-rescue` subagent in the background/i);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /Do not forward them to `task`/i);
  assert.match(rescue, /`--model` and `--effort` are runtime-selection flags/i);
  assert.match(rescue, /accepted effort values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`/i);
  assert.match(rescue, /`max` is explicit-only and `ultra` is not a valid effort value/i);
  assert.match(rescue, /If they ask for `spark`, map it to `gpt-5\.3-codex-spark`/i);
  assert.match(rescue, /If the request includes `--fresh`, do not ask whether to continue/i);
  assert.match(rescue, /If the user chooses continue, add `--resume`/i);
  assert.match(rescue, /If the user chooses a new thread, add `--fresh`/i);
  assert.match(rescue, /thin forwarder only/i);
  assert.match(rescue, /Return the Codex companion stdout verbatim to the user/i);
  assert.match(rescue, /Do not paraphrase, summarize, rewrite, or add commentary before or after it/i);
  assert.match(rescue, /return that command's stdout as-is/i);
  assert.match(rescue, /Leave `--resume`, `--resume-id <thread-id>`, and `--fresh` in the forwarded request/i);
  assert.match(rescue, /codex:codex-prompting/);
  assert.match(rescue, /Resume flow[\s\S]*Fresh flow/i);
  assert.match(rescue, /resume[\s\S]*do not load or apply `codex:gpt-5-6-routing`/i);
  assert.match(rescue, /`--resume`, `--resume-last`, or `--resume-id/);
  assert.match(rescue, /`--resume-last`[\s\S]*do not load or apply `codex:gpt-5-6-routing`/i);
  assert.match(rescue, /`--resume-id`[\s\S]*do not load or apply `codex:gpt-5-6-routing`/i);
  assert.match(rescue, /--resume-id <thread-id>/);
  assert.match(rescue, /skip.*task-resume-candidate.*--resume-id/is);
  assert.match(rescue, /skip.*GPT-5\.6 routing.*--resume-id/is);
  assert.match(rescue, /resume-id.*new delta/is);
  assert.match(rescue, /resume[\s\S]*preserve the thread's original model and effort defaults[\s\S]*only explicit user overrides/i);
  assert.match(rescue, /fresh[\s\S]*load `codex:gpt-5-6-routing`/i);
  assert.match(rescue, /Explicit model and effort[\s\S]*preserve both/i);
  assert.match(rescue, /Explicit model only[\s\S]*select only the effort/i);
  assert.match(rescue, /Explicit effort only[\s\S]*select only the model/i);
  assert.match(rescue, /Neither explicit[\s\S]*select both/i);
  assert.match(rescue, /ambiguous[\s\S]*higher tier/i);
  assert.match(rescue, /cannot decide[\s\S]*leave[\s\S]*unset/i);
  assert.match(rescue, /main Claude\/Fable context/i);
  assert.match(rescue, /main Claude context/i);
  assert.match(rescue, /<task>/);
  assert.match(rescue, /preserve.*exact/i);
  assert.doesNotMatch(rescue, /gpt-5-4-prompting/);
  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(agent, /--resume-id <thread-id>/);
  assert.match(agent, /do not replace.*--resume-last/is);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /model and effort[\s\S]*already resolved optional values/i);
  assert.match(agent, /If neither `--background` nor `--wait` is present, use foreground/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(agent, /Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(agent, /Omit `--model` or `--effort` when its resolved value is unset/i);
  assert.match(agent, /Do not evaluate task complexity/i);
  assert.match(agent, /Do not choose or change the model or effort/i);
  assert.match(agent, /Return the stdout of the `codex-companion` command exactly as-is/i);
  assert.match(agent, /Keep invocation errors visible/i);
  assert.match(agent, /Do not rewrite or reshape/i);
  assert.doesNotMatch(agent, /gpt-5-4-prompting/);
  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(runtimeSkill, /transports? the prompt received from the main context unchanged/i);
  assert.doesNotMatch(runtimeSkill, /gpt-5-4-prompting/);
  assert.match(runtimeSkill, /If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only/i);
  assert.match(runtimeSkill, /Strip it before calling `task`/i);
  assert.match(runtimeSkill, /`--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`/i);
  assert.match(runtimeSkill, /`max` is explicit-only and `ultra` is not a valid effort value/i);
  assert.match(runtimeSkill, /--resume-id <thread-id>/);
  assert.match(runtimeSkill, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(readme, /`codex:codex-rescue` subagent/i);
  assert.match(readme, /if you do not pass `--model` or `--effort`, Codex chooses its own defaults/i);
  assert.match(readme, /--model gpt-5\.4-mini --effort medium/i);
  assert.match(readme, /`spark`, the plugin maps that to `gpt-5\.3-codex-spark`/i);
  assert.match(readme, /continue a previous Codex task/i);
  assert.match(readme, /--resume-id thr_[a-z0-9_-]+/i);
  assert.match(readme, /--background --resume-id thr_[a-z0-9_-]+/i);
  assert.match(readme, /resume-id.*mutually exclusive.*resume.*fresh/is);
  assert.match(readme, /### `\/codex:setup`/);
  assert.match(readme, /### `\/codex:review`/);
  assert.match(readme, /### `\/codex:adversarial-review`/);
  assert.match(readme, /uses the same review target selection as `\/codex:review`/i);
  assert.match(readme, /--base main challenge whether this was the right caching and retry design/);
  assert.match(readme, /### `\/codex:rescue`/);
  assert.match(readme, /### `\/codex:transfer`/);
  assert.match(readme, /### `\/codex:status`/);
  assert.match(readme, /### `\/codex:result`/);
  assert.match(readme, /### `\/codex:cancel`/);
});

test("transfer, result, and cancel commands are exposed as deterministic runtime entrypoints", () => {
  const transfer = read("commands/transfer.md");
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/codex-result-handling/SKILL.md");

  assert.match(transfer, /disable-model-invocation:\s*true/);
  assert.match(transfer, /codex-companion\.mjs" transfer "\$ARGUMENTS"/);
  assert.match(transfer, /codex resume <session-id>/);
  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /codex-companion\.mjs" result "\$ARGUMENTS"/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /codex-companion\.mjs" cancel "\$ARGUMENTS"/);
  assert.match(resultHandling, /do not turn a failed or incomplete Codex run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Codex was never successfully invoked, do not generate a substitute answer at all/i);
});

test("internal docs use task terminology for rescue runs", () => {
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");

  assert.match(runtimeSkill, /codex-companion\.mjs" task "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
  assert.match(runtimeSkill, /task --resume-last/i);
});

test("preloaded rescue runtime forwards resolved routing and visible errors", () => {
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");

  assert.match(runtimeSkill, /model and effort[\s\S]*already resolved optional values/i);
  assert.match(runtimeSkill, /pass resolved `--model` and `--effort` values through unchanged/i);
  assert.match(runtimeSkill, /omit either flag when its resolved value is unset/i);
  assert.match(runtimeSkill, /keep Bash and runtime invocation errors visible/i);
  assert.doesNotMatch(runtimeSkill, /If the Bash call fails or Codex cannot be invoked, return nothing/i);
});

test("internal Codex prompting skill is model-neutral and preserves native task contracts", () => {
  const promptingSkill = read("skills/codex-prompting/SKILL.md");

  assert.match(promptingSkill, /^user-invocable:\s*false$/m);
  assert.match(promptingSkill, /For a fresh implementation task, preserve the user's original task text exactly/i);
  assert.match(promptingSkill, /<task>[\s\S]*the user's exact task text[\s\S]*<\/task>/i);
  assert.match(promptingSkill, /Add these blocks only when they contain concrete information already known/i);
  assert.match(promptingSkill, /<scope_and_success>[\s\S]*<\/scope_and_success>/i);
  assert.match(promptingSkill, /<evidence_and_final_response>[\s\S]*<\/evidence_and_final_response>/i);
  assert.match(promptingSkill, /For a resume, send only the user's new delta or correction/i);
  assert.match(promptingSkill, /Do not repeat the original task or previously supplied context/i);
  assert.match(promptingSkill, /For review and adversarial-review work, retain the review command's native finding-first contract/i);
  assert.match(promptingSkill, /Do not add generic instructions such as “be concise” or “think harder,”/i);
  assert.match(promptingSkill, /do not request hidden chain-of-thought/i);
});

test("hooks manifest contains only supported top-level fields", () => {
  const hooks = JSON.parse(read("hooks/hooks.json"));
  assert.deepEqual(Object.keys(hooks), ["hooks"]);
  assert.ok(Array.isArray(hooks.hooks.SessionEnd));
});

test("setup command can offer Codex install and still points users to codex login", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\]'/);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /npm install -g @openai\/codex/);
  assert.match(setup, /codex-companion\.mjs" setup --json \$ARGUMENTS/);
  assert.match(readme, /!codex login/);
  assert.match(readme, /offer to install Codex for you/i);
  assert.match(readme, /\/codex:setup --enable-review-gate/);
  assert.match(readme, /\/codex:setup --disable-review-gate/);
});
