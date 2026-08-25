
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
test("ships the explicit orchestration command and automatic-entry skill", () => { const command = read("plugins/codex/commands/orchestrate.md"); const skill = read("plugins/codex/skills/codex-orchestration/SKILL.md"); assert.match(command, /3–6 line plan/); assert.match(command, /cli\.mjs/); assert.doesNotMatch(command, /codex-rescue/); assert.match(skill, /Complexity Score/); assert.match(skill, /Sol > Terra > Luna/); assert.match(skill, /strictly read-only/); assert.match(skill, /autoEnabled/); });
