import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";

const REVIEW_CONFIG = {
  valueOptions: ["base", "scope", "model", "effort", "cwd"],
  booleanOptions: ["json", "background", "wait"],
  aliasMap: { m: "model" }
};

test("parseArgs reports an unrecognised long option instead of silently demoting it", () => {
  const { options, positionals, unknownOptions } = parseArgs(
    ["--model", "gpt-6-astra", "--nonsense", "value"],
    { valueOptions: ["model"], booleanOptions: [] }
  );

  assert.equal(options.model, "gpt-6-astra");
  // Behaviour is unchanged: the token still reaches positionals, because some
  // commands take free-form text after their flags.
  assert.deepEqual(positionals, ["--nonsense", "value"]);
  // But it is now reported, so a caller can warn rather than swallow it.
  assert.deepEqual(unknownOptions, ["--nonsense"]);
});

test("parseArgs reports nothing when every option is recognised", () => {
  const { unknownOptions } = parseArgs(["--model", "gpt-6-astra", "--json"], {
    valueOptions: ["model"],
    booleanOptions: ["json"]
  });

  assert.deepEqual(unknownOptions, []);
});

test("parseArgs does not treat text after -- as an unrecognised option", () => {
  const { positionals, unknownOptions } = parseArgs(["--", "--not-a-flag"], {
    valueOptions: [],
    booleanOptions: []
  });

  assert.deepEqual(positionals, ["--not-a-flag"]);
  assert.deepEqual(unknownOptions, []);
});

test("review commands accept --effort rather than folding it into the focus text", () => {
  const { options, positionals, unknownOptions } = parseArgs(
    ["--model", "gpt-6-astra", "--effort", "xhigh", "focus", "on", "auth"],
    REVIEW_CONFIG
  );

  assert.equal(options.model, "gpt-6-astra");
  assert.equal(options.effort, "xhigh");
  assert.deepEqual(unknownOptions, []);
  // The regression this guards: --effort and xhigh used to land here and be
  // joined into the prompt the reviewer was given.
  assert.deepEqual(positionals, ["focus", "on", "auth"]);
  assert.equal(positionals.join(" "), "focus on auth");
});

test("splitRawArgumentString keeps a quoted focus phrase together", () => {
  assert.deepEqual(
    splitRawArgumentString('--model gpt-6-astra --effort xhigh "the auth path"'),
    ["--model", "gpt-6-astra", "--effort", "xhigh", "the auth path"]
  );
});
