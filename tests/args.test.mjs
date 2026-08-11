import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";

test("parseArgs preserves all equals signs in inline values", () => {
  assert.deepEqual(
    parseArgs(["--check=FOO=bar npm test", "--check=KEY=value=again"], {
      valueOptions: ["check"],
      repeatableValueOptions: ["check"]
    }),
    {
      options: { check: ["FOO=bar npm test", "KEY=value=again"] },
      positionals: []
    }
  );
});

test("parseArgs keeps empty inline values and separate values", () => {
  assert.deepEqual(
    parseArgs(["--value=", "--other", "plain"], { valueOptions: ["value", "other"] }),
    { options: { value: "", other: "plain" }, positionals: [] }
  );
});

test("splitRawArgumentString preserves regex backslashes inside a quoted check command", () => {
  assert.deepEqual(
    splitRawArgumentString(`--check "rg '\\bfoo\\b'"`),
    ["--check", "rg '\\bfoo\\b'"]
  );
});

test("splitRawArgumentString retains quoted values and unquoted escaped spaces", () => {
  assert.deepEqual(
    splitRawArgumentString(`--base "origin/main" focus\\ text --check "npm test"`),
    ["--base", "origin/main", "focus text", "--check", "npm test"]
  );
});

test("splitRawArgumentString strips double-quote escape syntax without expanding commands", () => {
  assert.deepEqual(
    splitRawArgumentString(`--check "printf \\\"ok\\\""`),
    ["--check", "printf \"ok\""]
  );
});
