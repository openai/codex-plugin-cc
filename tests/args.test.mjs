import test from "node:test";
import assert from "node:assert/strict";

import { CODEX_PLUGIN_ARGS_ENV, getCodexPassthroughArgs } from "../plugins/codex/scripts/lib/args.mjs";

test("getCodexPassthroughArgs returns [] when the env var is unset", () => {
  assert.deepEqual(getCodexPassthroughArgs({}), []);
});

test("getCodexPassthroughArgs returns [] for blank values", () => {
  assert.deepEqual(getCodexPassthroughArgs({ [CODEX_PLUGIN_ARGS_ENV]: "   " }), []);
});

test("getCodexPassthroughArgs tokenizes a simple config override", () => {
  assert.deepEqual(getCodexPassthroughArgs({ [CODEX_PLUGIN_ARGS_ENV]: "-c model_provider=my-provider" }), [
    "-c",
    "model_provider=my-provider"
  ]);
});

test("getCodexPassthroughArgs honors quotes and multiple flags", () => {
  assert.deepEqual(
    getCodexPassthroughArgs({ [CODEX_PLUGIN_ARGS_ENV]: `-c model_provider=my-provider -c 'base_url=https://x/v1'` }),
    ["-c", "model_provider=my-provider", "-c", "base_url=https://x/v1"]
  );
});
