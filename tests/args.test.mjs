import test from "node:test";
import assert from "node:assert/strict";

import {
  CODEX_PLUGIN_ARGS_ENV,
  getCodexPassthroughArgs,
  splitRawArgumentString
} from "../plugins/codex/scripts/lib/args.mjs";

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

test("getCodexPassthroughArgs keeps backslashes literal inside single quotes", () => {
  assert.deepEqual(getCodexPassthroughArgs({ [CODEX_PLUGIN_ARGS_ENV]: `--add-dir 'C:\\work\\repo'` }), [
    "--add-dir",
    "C:\\work\\repo"
  ]);
});

test("splitRawArgumentString: single quotes preserve backslashes, double quotes still escape", () => {
  assert.deepEqual(splitRawArgumentString(`'C:\\work\\repo'`), ["C:\\work\\repo"]);
  assert.deepEqual(splitRawArgumentString(`"a\\"b"`), [`a"b`]);
  assert.deepEqual(splitRawArgumentString(`foo\\ bar`), ["foo bar"]);
});

test("splitRawArgumentString: double quotes keep backslashes before ordinary chars (POSIX)", () => {
  // `\w` and `\r` are not escapable inside double quotes, so the backslash stays.
  assert.deepEqual(splitRawArgumentString(`"C:\\work\\repo"`), ["C:\\work\\repo"]);
  // `\\` collapses to a single backslash; `\$` and `` \` `` drop the backslash.
  assert.deepEqual(splitRawArgumentString(`"a\\\\b"`), ["a\\b"]);
  assert.deepEqual(splitRawArgumentString(`"price \\$5"`), ["price $5"]);
});

test("getCodexPassthroughArgs keeps backslashes literal inside double quotes", () => {
  assert.deepEqual(getCodexPassthroughArgs({ [CODEX_PLUGIN_ARGS_ENV]: `--add-dir "C:\\work\\repo"` }), [
    "--add-dir",
    "C:\\work\\repo"
  ]);
});
