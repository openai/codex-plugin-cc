
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import {
  DEFAULT_AUTO_THRESHOLD,
  DEFAULT_GLOBAL_ACTIVE_CODEX_LIMIT,
  DEFAULT_GLOBAL_TOP_LEVEL_LIMIT,
  DEFAULT_IDLE_TTL_MINUTES,
  DEFAULT_WORKSPACE_POOL_SIZE
} from "./constants.mjs";

export const DEFAULT_ORCHESTRATION_CONFIG = Object.freeze({
  auto: Object.freeze({ enabled: false, threshold: DEFAULT_AUTO_THRESHOLD }),
  workers: Object.freeze({
    workspacePoolSize: DEFAULT_WORKSPACE_POOL_SIZE,
    globalTopLevelLimit: DEFAULT_GLOBAL_TOP_LEVEL_LIMIT,
    globalActiveCodexLimit: DEFAULT_GLOBAL_ACTIVE_CODEX_LIMIT,
    idleTtlMinutes: DEFAULT_IDLE_TTL_MINUTES
  })
});

export function getUserConfigPath(options = {}) {
  return path.join(options.homeDir ?? os.homedir(), ".claude", "codex-orchestration.json");
}

export function getProjectConfigPath(workspaceRoot) {
  return path.join(workspaceRoot, ".claude", "codex-orchestration.json");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeObjects(base, patch) {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    result[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? mergeObjects(base[key], value) : value;
  }
  return result;
}

function readConfig(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!isPlainObject(parsed)) throw new Error(`${filePath} must contain a JSON object.`);
  return parsed;
}

function integerIn(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
}

export function validateOrchestrationConfig(config) {
  for (const key of Object.keys(config)) {
    if (!new Set(["auto", "workers"]).has(key)) throw new Error(`Unknown orchestration configuration key: ${key}`);
  }
  if (!isPlainObject(config.auto) || typeof config.auto.enabled !== "boolean") {
    throw new Error("auto.enabled must be a boolean.");
  }
  integerIn(config.auto.threshold, 0, 10, "auto.threshold");
  if (!isPlainObject(config.workers)) throw new Error("workers must be an object.");
  integerIn(config.workers.workspacePoolSize, 1, 8, "workers.workspacePoolSize");
  integerIn(config.workers.globalTopLevelLimit, 1, 8, "workers.globalTopLevelLimit");
  integerIn(config.workers.globalActiveCodexLimit, 1, 12, "workers.globalActiveCodexLimit");
  integerIn(config.workers.idleTtlMinutes, 0, 60, "workers.idleTtlMinutes");
  return config;
}

export function loadOrchestrationConfig(workspaceRoot, options = {}) {
  const userPath = getUserConfigPath(options);
  const projectPath = getProjectConfigPath(workspaceRoot);
  const config = mergeObjects(
    mergeObjects(DEFAULT_ORCHESTRATION_CONFIG, readConfig(userPath)),
    readConfig(projectPath)
  );
  return validateOrchestrationConfig(config);
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

export function patchUserOrchestrationConfig(patch, options = {}) {
  const filePath = getUserConfigPath(options);
  const existing = readConfig(filePath);
  const mergedUser = mergeObjects(existing, patch);
  const effective = validateOrchestrationConfig(mergeObjects(DEFAULT_ORCHESTRATION_CONFIG, mergedUser));
  writeJsonAtomic(filePath, mergedUser);
  return effective;
}
