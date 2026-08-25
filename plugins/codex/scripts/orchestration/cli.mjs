#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { parseArgs } from "../lib/args.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { getProjectConfigPath, getUserConfigPath, loadOrchestrationConfig } from "./config.mjs";
import { OrchestrationControllerClient } from "./controller-client.mjs";
import { ensureControllerServer } from "./controller-lifecycle.mjs";
import { buildOrchestrationResult } from "./result-contract.mjs";
import { isTerminalState, listOrchestrations, loadOrchestrationState, resolveOrchestrationReference } from "./state-store.mjs";

function output(value, json) { process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : render(value)); }
function render(value) {
  if (value?.orchestrationId && value?.packageCount != null) return `Multi-Codex orchestration ${value.orchestrationId} accepted.\nStatus: ${value.status}\nPackages: ${value.packageCount}\nStatus: /codex:status ${value.orchestrationId}\nResult: /codex:result ${value.orchestrationId}\nCancel: /codex:cancel ${value.orchestrationId}\n`;
  return `${JSON.stringify(value, null, 2)}\n`;
}
function readPiped() { if (process.stdin.isTTY) return ""; return fs.readFileSync(0, "utf8"); }
function durableStatus(cwd, reference) {
  if (!reference) return { workspaceRoot: cwd, orchestrations: listOrchestrations(cwd) };
  const resolved = resolveOrchestrationReference(cwd, reference); const state = loadOrchestrationState(cwd, resolved.orchestrationId);
  return resolved.kind === "package" ? { orchestrationId: state.id, packageSpec: state.plan.packages.find((pkg) => pkg.id === resolved.packageId), package: state.packages[resolved.packageId] } : state;
}
function durableResult(cwd, reference) {
  const resolved = resolveOrchestrationReference(cwd, reference); const state = loadOrchestrationState(cwd, resolved.orchestrationId);
  if (resolved.kind === "package") return state.packages[resolved.packageId].result;
  if (!isTerminalState(state)) throw new Error(`Orchestration ${state.id} is still running. Use /codex:status ${state.id}.`);
  return buildOrchestrationResult(state);
}
async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const { options, positionals } = parseArgs(argv, { valueOptions: ["cwd", "plan-file"], booleanOptions: ["json"] });
  const cwd = resolveWorkspaceRoot(options.cwd ? path.resolve(options.cwd) : process.cwd());
  if (command === "config") {
    const effectiveConfig = loadOrchestrationConfig(cwd);
    output({ workspaceRoot: cwd, userConfigPath: getUserConfigPath(), projectConfigPath: getProjectConfigPath(cwd), effectiveConfig, autoEnabled: effectiveConfig.auto.enabled, autoThreshold: effectiveConfig.auto.threshold }, options.json); return;
  }
  if (command === "start") {
    const planText = options["plan-file"] ? fs.readFileSync(path.resolve(options["plan-file"]), "utf8") : readPiped();
    if (!planText.trim()) throw new Error("start requires --plan-file or piped plan JSON.");
    const session = await ensureControllerServer(cwd); const client = new OrchestrationControllerClient(session.endpoint);
    const summary = await client.start(JSON.parse(planText), { claudeSessionId: process.env.CODEX_COMPANION_SESSION_ID ?? null });
    output({ ...summary, commands: { status: `/codex:status ${summary.orchestrationId}`, result: `/codex:result ${summary.orchestrationId}`, cancel: `/codex:cancel ${summary.orchestrationId}` } }, options.json); return;
  }
  const reference = positionals[0] ?? "";
  if (command === "status") { output(durableStatus(cwd, reference), options.json); return; }
  if (command === "result") { if (!reference) throw new Error("result requires an orchestration or package reference."); output(durableResult(cwd, reference), options.json); return; }
  if (command === "cancel") {
    if (!reference) throw new Error("cancel requires an orchestration or package reference.");
    const state = durableStatus(cwd, reference); const orchestrationState = state.package ? loadOrchestrationState(cwd, state.orchestrationId) : state;
    if (isTerminalState(orchestrationState)) { output(orchestrationState, options.json); return; }
    const session = await ensureControllerServer(cwd); const client = new OrchestrationControllerClient(session.endpoint); output(await client.cancel(reference), options.json); return;
  }
  throw new Error("Usage: cli.mjs <config|start|status|result|cancel> ...");
}
main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
