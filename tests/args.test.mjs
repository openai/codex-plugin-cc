import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";

test("parseArgs can keep option-like text positional after focus starts", () => {
  const argv = splitRawArgumentString("--base main review whether --model pm_v6_2 leaks");
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["base", "model"],
    stopParsingOptionsAfterFirstPositional: true
  });

  assert.deepEqual(options, { base: "main" });
  assert.deepEqual(positionals, ["review", "whether", "--model", "pm_v6_2", "leaks"]);
});

test("parseArgs can keep leading option-like text positional in focus mode", () => {
  const argv = splitRawArgumentString("--base main --not --model pm_v6_2 leaks");
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["base", "model"],
    stopParsingOptionsAfterFirstPositional: true
  });

  assert.deepEqual(options, { base: "main" });
  assert.deepEqual(positionals, ["--not", "--model", "pm_v6_2", "leaks"]);
});
