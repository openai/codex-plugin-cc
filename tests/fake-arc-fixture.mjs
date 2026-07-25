import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export function installFakeArc(binDir) {
  const logPath = path.join(binDir, "fake-arc-calls.jsonl");
  const scriptPath = path.join(binDir, "arc");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");

const LOG_PATH = ${JSON.stringify(logPath)};
const args = process.argv.slice(2);
fs.appendFileSync(LOG_PATH, JSON.stringify({ cwd: process.cwd(), args }) + "\\n");

function outputEnv(name, fallback) {
  process.stdout.write(process.env[name] == null ? fallback : process.env[name]);
}

const behavior = process.env.FAKE_ARC_BEHAVIOR || "ok";
if (args[0] === "root") {
  process.stderr.write("arc root is forbidden in tests\\n");
  process.exit(97);
}
if (args[0] === "info" && args.includes("--json")) {
  if (behavior === "outside-workspace") {
    process.stderr.write("not an Arc workspace\\n");
    process.exit(1);
  }
  if (behavior === "malformed-info") {
    process.stdout.write("{broken");
    process.exit(0);
  }
  outputEnv("FAKE_ARC_INFO_JSON", JSON.stringify({ branch: "users/test/feature" }));
  process.exit(0);
}
if (args[0] === "status" && args.includes("--json")) {
  if (behavior === "malformed-status") {
    process.stdout.write("{broken");
    process.exit(0);
  }
  outputEnv(
    "FAKE_ARC_STATUS_JSON",
    JSON.stringify({ staged: [], changed: [], untracked: [] })
  );
  process.exit(0);
}
if (args[0] === "diff") {
  if (behavior === "diff-fails") {
    process.stderr.write("simulated Arc diff failure\\n");
    process.exit(2);
  }
  if (args.includes("--name-only")) {
    outputEnv("FAKE_ARC_NAME_ONLY", "");
    process.exit(0);
  }
  if (args.includes("--stat")) {
    outputEnv("FAKE_ARC_DIFF_STAT", "");
    process.exit(0);
  }
  if (args.includes("-B")) {
    outputEnv("FAKE_ARC_BRANCH_DIFF", "");
    process.exit(0);
  }
  if (args.includes("--cached")) {
    outputEnv("FAKE_ARC_STAGED_DIFF", "");
    process.exit(0);
  }
  outputEnv("FAKE_ARC_UNSTAGED_DIFF", "");
  process.exit(0);
}

process.stderr.write("unsupported fake Arc invocation: " + args.join(" ") + "\\n");
process.exit(64);
`;
  writeExecutable(scriptPath, source);
  return { scriptPath, logPath };
}

export function buildArcEnv(binDir, overrides = {}) {
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    ...overrides
  };
}

export function readArcCalls(logPath) {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  return fs.readFileSync(logPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
