#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { patchUserOrchestrationConfig } from "./config.mjs";
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2); const enable = args.includes("--enable-orchestration"); const disable = args.includes("--disable-orchestration");
if (enable && disable) throw new Error("Choose either --enable-orchestration or --disable-orchestration.");
if (enable || disable) patchUserOrchestrationConfig({ auto: { enabled: enable } });
const forwarded = args.filter((arg) => !["--enable-orchestration", "--disable-orchestration"].includes(arg));
const result = spawnSync(process.execPath, [path.join(ROOT, "codex-companion.mjs"), "setup", ...forwarded], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
if (enable || disable) process.stdout.write(`Orchestration auto-entry: ${enable ? "enabled" : "disabled"}.\n`);
process.exitCode = result.status ?? 1;
