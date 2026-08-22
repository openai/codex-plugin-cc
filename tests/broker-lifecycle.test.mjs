import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { teardownBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

test("teardownBrokerSession ignores EPERM unlink failures for pid/log files", () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-broker-teardown-"));
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const socketPath = path.join(sessionDir, "broker.sock");
  fs.writeFileSync(pidFile, "123\n", "utf8");
  fs.writeFileSync(logFile, "log\n", "utf8");
  fs.writeFileSync(socketPath, "", "utf8");

  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = (target) => {
    if (target === pidFile || target === logFile) {
      const error = new Error(`EPERM: operation not permitted, unlink '${target}'`);
      error.code = "EPERM";
      throw error;
    }
    return originalUnlinkSync(target);
  };

  try {
    assert.doesNotThrow(() =>
      teardownBrokerSession({
        endpoint: `unix:${socketPath}`,
        pidFile,
        logFile,
        sessionDir,
      }),
    );
    assert.equal(fs.existsSync(socketPath), false);
  } finally {
    fs.unlinkSync = originalUnlinkSync;
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
