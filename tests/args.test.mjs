import test from "node:test";
import assert from "node:assert/strict";

import { splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";

test("splitRawArgumentString preserves backslashes in an unquoted Windows path", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`--cwd C:\Users\me\repo`), [
    "--cwd",
    String.raw`C:\Users\me\repo`
  ]);
});

test("splitRawArgumentString preserves a quoted Windows path with spaces", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`--cwd "C:\Program Files\App"`), [
    "--cwd",
    String.raw`C:\Program Files\App`
  ]);
});

test("splitRawArgumentString closes a quoted Windows path after a trailing backslash", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`"C:\Program Files\Repo\" --write`), [
    "C:\\Program Files\\Repo\\",
    "--write"
  ]);
});

test("splitRawArgumentString closes a final quoted Windows path after a trailing backslash", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`--cwd "C:\Program Files\Repo\"`), [
    "--cwd",
    "C:\\Program Files\\Repo\\"
  ]);
});

test("splitRawArgumentString closes a trailing-backslash path before another quoted token", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`"C:\path\" "second"`), ["C:\\path\\", "second"]);
});

test("splitRawArgumentString accepts an escaped quote inside double quotes", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`"say \"hello\""`), ['say "hello"']);
});

test("splitRawArgumentString preserves escaped quotes at word boundaries", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`"say \"hello\" now"`), ['say "hello" now']);
});

test("splitRawArgumentString preserves an escaped quote before a non-boundary character", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`"say \"hi\"..."`), ['say "hi"...']);
});

test("splitRawArgumentString parses plain prompts with quoted phrases", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`run "quoted phrase" and "another phrase"`), [
    "run",
    "quoted phrase",
    "and",
    "another phrase"
  ]);
});

test("splitRawArgumentString collapses an escaped backslash", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`C:\\repo`), [String.raw`C:\repo`]);
});

test("splitRawArgumentString preserves a trailing backslash", () => {
  assert.deepEqual(splitRawArgumentString("--cwd C:\\repo\\"), ["--cwd", "C:\\repo\\"]);
});
