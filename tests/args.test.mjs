import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";

// --- parseArgs ---

test("parseArgs: boolean flag --flag=true sets true, --flag=false sets false", () => {
  const configTrue = parseArgs(["--verbose=true"], { booleanOptions: ["verbose"] });
  assert.equal(configTrue.options.verbose, true);

  const configFalse = parseArgs(["--verbose=false"], { booleanOptions: ["verbose"] });
  assert.equal(configFalse.options.verbose, false);
});

test("parseArgs: value option --output consumes next token", () => {
  const { options } = parseArgs(["--output", "/tmp/out.txt"], { valueOptions: ["output"] });
  assert.equal(options.output, "/tmp/out.txt");
});

test("parseArgs: inline value --output=path uses inline value", () => {
  const { options } = parseArgs(["--output=/tmp/out.txt"], { valueOptions: ["output"] });
  assert.equal(options.output, "/tmp/out.txt");
});

test("parseArgs: short alias -o resolved via aliasMap", () => {
  const { options } = parseArgs(["-o", "/tmp/out.txt"], {
    valueOptions: ["output"],
    aliasMap: { o: "output" },
  });
  assert.equal(options.output, "/tmp/out.txt");
});

test("parseArgs: positionals after -- land in positionals array", () => {
  const { options, positionals } = parseArgs(
    ["--verbose", "--", "--not-a-flag", "file.txt"],
    { booleanOptions: ["verbose"] }
  );
  assert.equal(options.verbose, true);
  assert.deepEqual(positionals, ["--not-a-flag", "file.txt"]);
});

test("parseArgs: missing value for value option throws Error", () => {
  assert.throws(
    () => parseArgs(["--output"], { valueOptions: ["output"] }),
    { message: "Missing value for --output" }
  );
});

// --- splitRawArgumentString ---

test("splitRawArgumentString: space-separated tokens", () => {
  assert.deepEqual(splitRawArgumentString("foo bar baz"), ["foo", "bar", "baz"]);
});

test("splitRawArgumentString: single-quoted string with spaces becomes one token", () => {
  assert.deepEqual(splitRawArgumentString("hello 'foo bar' world"), ["hello", "foo bar", "world"]);
});

test("splitRawArgumentString: double-quoted string with spaces becomes one token", () => {
  assert.deepEqual(splitRawArgumentString('hello "foo bar" world'), ["hello", "foo bar", "world"]);
});

test("splitRawArgumentString: backslash escape preserves next char", () => {
  assert.deepEqual(splitRawArgumentString("foo\\ bar baz"), ["foo bar", "baz"]);
});

test("splitRawArgumentString: trailing backslash appended literally", () => {
  assert.deepEqual(splitRawArgumentString("foo\\"), ["foo\\"]);
});
