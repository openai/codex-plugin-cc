import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");

test("spark resolves to Luna", () => {
  const source = fs.readFileSync(SCRIPT, "utf8");
  const retiredSparkModel = new RegExp(["gpt", "5\\.3", "codex", "spark"].join("-"));
  assert.match(source, /\["spark", "gpt-5\.6-luna"\]/);
  assert.doesNotMatch(source, retiredSparkModel);
});

test("minimal effort is rejected before Codex starts", () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "task", "--effort", "minimal", "no-op"],
    { cwd: ROOT, encoding: "utf8" }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported reasoning effort "minimal"/);
});

test("command hints omit minimal effort", () => {
  const files = [
    "commands/review.md",
    "commands/adversarial-review.md",
    "commands/rescue.md",
    "skills/codex-cli-runtime/SKILL.md"
  ];
  for (const relativePath of files) {
    const source = fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
    assert.doesNotMatch(source, /minimal/);
  }
});
