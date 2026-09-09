import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_PATH = path.join(ROOT, "plugins", "codex", "hooks", "hooks.json");

test("SessionEnd stays within the Codex runtime teardown budget", () => {
  const manifest = JSON.parse(fs.readFileSync(HOOKS_PATH, "utf8"));
  const handlers = manifest.hooks.SessionEnd.flatMap((group) => group.hooks);

  assert.ok(handlers.length > 0, "SessionEnd must remain configured");
  for (const handler of handlers) {
    assert.ok(
      handler.timeout <= 3,
      `SessionEnd timeout ${handler.timeout}s exceeds the Codex runtime 3s hard cap`
    );
  }
});
