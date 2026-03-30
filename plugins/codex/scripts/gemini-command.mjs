#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function quoteRawArg(value) {
  const normalized = String(value ?? "").replace(/\\/g, "/");
  return `"${normalized.replace(/"/g, '\\"')}"`;
}

function buildCompanionArgString(workspacePath, rawArgs) {
  const parts = ["--cwd", quoteRawArg(path.resolve(workspacePath))];
  const trimmedArgs = String(rawArgs ?? "").trim();
  if (trimmedArgs) {
    parts.push(trimmedArgs);
  }
  return parts.join(" ");
}

function main() {
  const [subcommand, workspacePath, ...rest] = process.argv.slice(2);
  if (!subcommand || !workspacePath) {
    process.stderr.write("Usage: node gemini-command.mjs <subcommand> <workspace-path> [raw-args]\n");
    process.exit(1);
  }

  const rawArgs = rest.join(" ").trim();
  const companionScript = path.resolve(fileURLToPath(new URL("./codex-companion.mjs", import.meta.url)));
  const companionArgString = buildCompanionArgString(workspacePath, rawArgs);
  const result = spawnSync(process.execPath, [companionScript, subcommand, companionArgString], {
    cwd: workspacePath,
    env: process.env,
    encoding: "utf8",
    stdio: "pipe"
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 0);
}

main();
