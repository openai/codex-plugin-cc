import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { runStopReview } from "../plugins/codex/scripts/stop-review-gate-hook.mjs";
import { makeTempDir } from "./helpers.mjs";

test("runStopReview hides stop-gate task windows on Windows", () => {
  const cwd = makeTempDir();
  let captured = null;

  const result = runStopReview(
    cwd,
    {
      session_id: "session-123",
      last_assistant_message: "Looks good."
    },
    {
      spawnSyncImpl(command, args, options) {
        captured = { command, args, options };
        return {
          status: 0,
          stdout: JSON.stringify({ rawOutput: "ALLOW: no blocking issues" }),
          stderr: "",
          error: null
        };
      }
    }
  );

  assert.equal(result.ok, true);
  assert.equal(captured.command, process.execPath);
  assert.deepEqual(captured.args.slice(1, 3), ["task", "--json"]);
  assert.equal(path.basename(captured.args[0]), "codex-companion.mjs");
  assert.equal(captured.options.cwd, cwd);
  assert.equal(captured.options.encoding, "utf8");
  assert.equal(captured.options.windowsHide, true);
  assert.equal(captured.options.env.CODEX_COMPANION_SESSION_ID, "session-123");
});
