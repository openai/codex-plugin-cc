import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";

const config = {
  valueOptions: ["base", "scope"],
  booleanOptions: ["wait", "background"],
  aliasMap: { b: "base", w: "wait" }
};

test("parseArgs handles separate and inline long-option values", () => {
  assert.deepEqual(parseArgs(["--base", "main", "--scope=branch", "focus"], config), {
    options: { base: "main", scope: "branch" },
    positionals: ["focus"]
  });
});

test("parseArgs handles boolean values and short aliases", () => {
  assert.deepEqual(parseArgs(["-w", "--background=false", "-b", "trunk"], config), {
    options: { wait: true, background: false, base: "trunk" },
    positionals: []
  });
});

test("parseArgs preserves unknown options as positionals", () => {
  assert.deepEqual(parseArgs(["--unknown=value", "-x", "-"], config), {
    options: {},
    positionals: ["--unknown=value", "-x", "-"]
  });
});

test("parseArgs treats every token after -- as positional", () => {
  assert.deepEqual(parseArgs(["--wait", "--", "--base", "main"], config), {
    options: { wait: true },
    positionals: ["--base", "main"]
  });
});

test("parseArgs rejects missing long-option values", () => {
  assert.throws(() => parseArgs(["--base"], config), /Missing value for --base/);
});

test("parseArgs rejects missing short-option values", () => {
  assert.throws(() => parseArgs(["-b"], config), /Missing value for -b/);
});

test("splitRawArgumentString groups single- and double-quoted text", () => {
  assert.deepEqual(splitRawArgumentString(`review "two words" 'single quoted' plain`), [
    "review",
    "two words",
    "single quoted",
    "plain"
  ]);
});

test("splitRawArgumentString handles escaped spaces, quotes, and backslashes", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`one\ two \"quoted\" path\\tail`), [
    "one two",
    '"quoted"',
    "path\\tail"
  ]);
});

test("splitRawArgumentString preserves a trailing backslash", () => {
  assert.deepEqual(splitRawArgumentString("value\\"), ["value\\"]);
});
