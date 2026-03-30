import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { splitRawArgumentString } from "./args.mjs";

const COMPANION_SCRIPT = path.resolve(fileURLToPath(new URL("../codex-companion.mjs", import.meta.url)));

function ensureTrailingNewline(text) {
  if (!text) {
    return "";
  }
  return text.endsWith("\n") ? text : `${text}\n`;
}

export function runCompanionCommand({ subcommand, workspacePath, rawArgs = "", env = process.env }) {
  const args = [
    COMPANION_SCRIPT,
    subcommand,
    "--cwd",
    path.resolve(workspacePath),
    ...splitRawArgumentString(String(rawArgs ?? "").trim())
  ];

  const result = spawnSync(process.execPath, args, {
    cwd: path.resolve(workspacePath),
    env,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

export function renderCompanionOutput(result) {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const succeeded = (result.status ?? 0) === 0;

  if (succeeded && stdout) {
    return ensureTrailingNewline(stdout);
  }

  if (succeeded && stderr) {
    return ensureTrailingNewline(stderr);
  }

  if (stderr || stdout) {
    return ensureTrailingNewline(`${stderr}${stdout}`);
  }

  return ensureTrailingNewline(`Command exited with code ${result.status ?? 1}.`);
}
