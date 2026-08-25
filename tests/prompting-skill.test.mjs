import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const read = (relativePath) => fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");

test("rescue uses version-neutral Codex prompting guidance", () => {
  const agent = read("agents/codex-rescue.md");
  const runtime = read("skills/codex-cli-runtime/SKILL.md");
  const skill = read("skills/codex-prompting/SKILL.md");

  assert.match(agent, /^\s*- codex-prompting\s*$/m);
  assert.match(agent, /Sol > Terra > Luna/);
  assert.match(agent, /reasoning effort is a separate/i);
  assert.match(agent, /spark.*gpt-5\.6-luna/i);
  assert.match(runtime, /codex-prompting/i);
  assert.match(runtime, /spark.*gpt-5\.6-luna/i);
  assert.match(runtime, /current Codex model catalog/i);
  assert.match(skill, /Favor lean, outcome-first prompts/i);
  assert.match(skill, /Define autonomy and approval boundaries/i);
  assert.match(skill, /Sol > Terra > Luna/);
  assert.match(skill, /Do not treat a higher effort on a lower tier as reversing/i);
});

test("generation-pinned prompting aliases are absent", () => {
  const legacyName = ["gpt", "5", "4", "prompting"].join("-");
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "skills", legacyName)), false);
});

test("prompting references are generation-neutral", () => {
  const files = [
    "skills/codex-prompting/SKILL.md",
    "skills/codex-prompting/references/prompt-blocks.md",
    "skills/codex-prompting/references/codex-prompt-recipes.md",
    "skills/codex-prompting/references/codex-prompt-antipatterns.md"
  ];
  const dottedLegacy = new RegExp(["GPT", "5\\.4"].join("-"), "i");
  const dashedLegacy = new RegExp(["gpt", "5", "4"].join("-"), "i");

  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(source, dottedLegacy);
    assert.doesNotMatch(source, dashedLegacy);
  }
});

test("repository context contains no generation-4 model identifiers", () => {
  const dottedLegacy = new RegExp(["gpt", "5\\.4"].join("-"), "i");
  const dashedLegacy = new RegExp(["gpt", "5", "4"].join("-"), "i");
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8"
  })
    .split("\0")
    .filter(Boolean)
    .filter((relativePath) => fs.existsSync(path.join(ROOT, relativePath)))
    .filter((relativePath) =>
      /(?:^|\/)(?:[^/]+\.(?:md|mjs|js|json|ts|yml|yaml|toml|txt)|README|LICENSE|NOTICE|\.gitignore)$/.test(relativePath)
    );

  for (const relativePath of files) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
    assert.doesNotMatch(source, dottedLegacy, relativePath);
    assert.doesNotMatch(source, dashedLegacy, relativePath);
  }
});

test("README presents GPT-5.6 as the only documented model family", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /gpt-5\.6-sol/);
  assert.match(readme, /gpt-5\.6-terra/);
  assert.match(readme, /gpt-5\.6-luna/);
  assert.match(readme, /spark.*gpt-5\.6-luna/i);
  assert.match(readme, /Sol > Terra > Luna/);
  assert.match(readme, /reasoning effort is a separate/i);
});
