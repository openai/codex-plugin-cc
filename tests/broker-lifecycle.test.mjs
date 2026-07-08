import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { spawnBrokerProcess } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { makeTempDir } from "./helpers.mjs";

test("spawnBrokerProcess hides detached broker windows on Windows", () => {
  const cwd = makeTempDir();
  const logFile = path.join(cwd, "broker.log");
  const pidFile = path.join(cwd, "broker.pid");
  let captured = null;
  let unrefCalled = false;

  const child = spawnBrokerProcess({
    scriptPath: path.join(cwd, "app-server-broker.mjs"),
    cwd,
    endpoint: "unix:/tmp/broker.sock",
    pidFile,
    logFile,
    env: { PATH: "/bin" },
    spawnImpl(command, args, options) {
      captured = { command, args, options };
      return {
        pid: 1234,
        unref() {
          unrefCalled = true;
        }
      };
    }
  });

  assert.equal(child.pid, 1234);
  assert.equal(unrefCalled, true);
  assert.equal(captured.options.cwd, cwd);
  assert.equal(captured.options.detached, true);
  assert.equal(captured.options.windowsHide, true);
  assert.deepEqual(captured.options.env, { PATH: "/bin" });
  assert.deepEqual(captured.options.stdio.slice(0, 1), ["ignore"]);
  assert.deepEqual(captured.args, [
    path.join(cwd, "app-server-broker.mjs"),
    "serve",
    "--endpoint",
    "unix:/tmp/broker.sock",
    "--cwd",
    cwd,
    "--pid-file",
    pidFile
  ]);
});
