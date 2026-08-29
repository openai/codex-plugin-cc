import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { ensureBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { makeTempDir, processIsAlive, writeExecutable } from "./helpers.mjs";

test("failed broker readiness terminates the detached broker", async () => {
  const cwd = makeTempDir("codex-plugin-broker-timeout-");
  const scriptPath = path.join(cwd, "silent-broker.mjs");
  const pidPath = path.join(cwd, "broker-child.pid");
  let pid = null;
  writeExecutable(
    scriptPath,
    `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`
  );

  try {
    const session = await ensureBrokerSession(cwd, {
      scriptPath,
      timeoutMs: 200
    });

    assert.equal(session, null);
    pid = Number(fs.readFileSync(pidPath, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(processIsAlive(pid), false);
  } finally {
    if (pid && processIsAlive(pid)) {
      process.kill(pid, "SIGKILL");
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
