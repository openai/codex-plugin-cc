#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { listOrchestrations, resolveOrchestrationReference } from "./state-store.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
function run(script, args) { const result = spawnSync(process.execPath, [script, ...args], { cwd: process.cwd(), env: process.env, encoding: "utf8" }); process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? ""); process.exitCode = result.status ?? 1; }
function isOrchestrationRef(reference) { if (!reference) return false; try { resolveOrchestrationReference(resolveWorkspaceRoot(process.cwd()), reference); return true; } catch { return false; } }
const [command, ...args] = process.argv.slice(2); const reference = args.find((arg) => !arg.startsWith("--")) ?? "";
const orchestrationCli = path.join(ROOT, "orchestration", "cli.mjs"); const companion = path.join(ROOT, "codex-companion.mjs");
if (command === "status" && !reference) {
  run(companion, ["status", ...args]);
  if (listOrchestrations(resolveWorkspaceRoot(process.cwd())).length) run(orchestrationCli, ["status", ...args]);
} else if (isOrchestrationRef(reference)) run(orchestrationCli, [command, ...args]);
else run(companion, [command, ...args]);
