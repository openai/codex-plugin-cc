import test from "node:test";
import assert from "node:assert/strict";

import { getSessionRuntimeStatus } from "../plugins/codex/scripts/lib/codex.mjs";
import { BROKER_DISABLE_ENV } from "../plugins/codex/scripts/lib/app-server.mjs";
import { makeTempDir } from "./helpers.mjs";

test("getSessionRuntimeStatus reports direct mode when disable-broker env is set", () => {
  const cwd = makeTempDir();
  const env = { [BROKER_DISABLE_ENV]: "true" };

  const status = getSessionRuntimeStatus(env, cwd);

  assert.equal(status.mode, "direct");
  assert.equal(status.endpoint, null);
  assert.ok(status.detail.includes("disabled by CODEX_COMPANION_APP_SERVER_DISABLE_BROKER"));
});

test("getSessionRuntimeStatus honors disable-broker env even when endpoint is set", () => {
  const cwd = makeTempDir();
  const env = {
    [BROKER_DISABLE_ENV]: "1",
    CODEX_COMPANION_APP_SERVER_ENDPOINT: "tcp://127.0.0.1:12345"
  };

  const status = getSessionRuntimeStatus(env, cwd);

  assert.equal(status.mode, "direct");
  assert.equal(status.endpoint, null);
});

test("getSessionRuntimeStatus reports shared mode when endpoint is set and disable is unset", () => {
  const cwd = makeTempDir();
  const env = {
    CODEX_COMPANION_APP_SERVER_ENDPOINT: "tcp://127.0.0.1:12345"
  };

  const status = getSessionRuntimeStatus(env, cwd);

  assert.equal(status.mode, "shared");
  assert.equal(status.endpoint, "tcp://127.0.0.1:12345");
});

test("getSessionRuntimeStatus reports direct mode when no endpoint or disable flag is set", () => {
  const cwd = makeTempDir();
  const status = getSessionRuntimeStatus({}, cwd);

  assert.equal(status.mode, "direct");
  assert.equal(status.endpoint, null);
});
