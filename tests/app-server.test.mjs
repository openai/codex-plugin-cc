import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import { BROKER_DISABLE_ENV, CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";

test("CodexAppServerClient.connect spawns directly when CODEX_COMPANION_APP_SERVER_DISABLE_BROKER is true", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const cwd = makeTempDir();
  const env = { ...buildEnv(binDir), [BROKER_DISABLE_ENV]: "true" };

  const client = await CodexAppServerClient.connect(cwd, { env });

  assert.equal(client.transport, "direct");
  await client.close();
});

test("CodexAppServerClient.connect accepts 1 as a truthy disableBroker env value", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const cwd = makeTempDir();
  const env = { ...buildEnv(binDir), [BROKER_DISABLE_ENV]: "1" };

  const client = await CodexAppServerClient.connect(cwd, { env });

  assert.equal(client.transport, "direct");
  await client.close();
});

test("CodexAppServerClient.connect treats an explicit disableBroker option as an override", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const cwd = makeTempDir();
  // Even though the env var is set, an explicit option wins.
  const client = await CodexAppServerClient.connect(cwd, {
    env: buildEnv(binDir),
    disableBroker: true
  });

  assert.equal(client.transport, "direct");
  await client.close();
});
