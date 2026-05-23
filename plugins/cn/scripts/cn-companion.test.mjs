#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const companion = path.join(here, "cn-companion.mjs");

function run(args) {
  return spawnSync(process.execPath, [companion, ...args], {
    cwd: path.join(here, "../../.."),
    encoding: "utf8",
    env: process.env,
  });
}

function runJson(args) {
  const result = run(args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

{
  const parsed = runJson([
    "task",
    "--model",
    "qwen",
    "--profile",
    "token",
    "--json",
    "--dry-run",
    "explain",
    "--json",
    "as",
    "literal",
  ]);
  assert.equal(parsed.model, "qwen");
  assert.equal(parsed.profile, "token");
  assert.equal(parsed.prompt, "explain --json as literal");
}

{
  const parsed = runJson([
    "task",
    "--model=glm",
    "--profile=max",
    "--timeout=7",
    "--json",
    "--dry-run",
    "--",
    "--profile",
    "is part of the prompt",
  ]);
  assert.equal(parsed.model, "glm");
  assert.equal(parsed.profile, "max");
  assert.equal(parsed.timeoutMs, 7000);
  assert.equal(parsed.prompt, "--profile is part of the prompt");
}

{
  const result = run(["task", "--model", "qwen", "--profile", "not-a-profile", "--dry-run", "hello"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown profile/);
}

{
  const result = run(["profiles"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /qwen\s+QWEN_PROFILE/);
  assert.match(result.stdout, /doubao\s+DOUBAO_PROFILE/);
}

console.log("cn-companion tests ok");
