import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { sendBrokerShutdown } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { createBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";

const tempDirs = new Set();
let testPluginDataDirs = null;

export function makeTempDir(prefix = "codex-plugin-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

export async function shutdownTestBrokers(pluginDataDir) {
  if (![...tempDirs].some((dir) => pluginDataDir === dir || pluginDataDir.startsWith(`${dir}${path.sep}`))) {
    throw new Error(`Refusing broker cleanup outside test temp directories: ${pluginDataDir}`);
  }
  const stateRoot = path.join(pluginDataDir, "state");
  if (!fs.existsSync(stateRoot)) return;
  for (const entry of fs.readdirSync(stateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sessionFile = path.join(stateRoot, entry.name, "broker.json");
    if (!fs.existsSync(sessionFile)) continue;
    const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    // Seeded status-only records have no pid file and do not own a broker.
    if (!session.pidFile || !fs.existsSync(session.pidFile)) continue;
    if (!session.sessionDir?.startsWith(`${os.tmpdir()}${path.sep}`) ||
        session.pidFile !== path.join(session.sessionDir, "broker.pid") ||
        session.endpoint !== createBrokerEndpoint(session.sessionDir)) {
      throw new Error(`Refusing broker cleanup for an unowned endpoint: ${sessionFile}`);
    }
    await sendBrokerShutdown(session.endpoint);
    let running = true;
    for (let attempt = 0; attempt < 100 && running; attempt += 1) {
      try {
        process.kill(session.pid, 0);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
        running = false;
      }
      if (running) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (running || fs.existsSync(session.pidFile)) throw new Error(`Test broker did not shut down: ${sessionFile}`);
  }
}

export function isolateTestEnvironment(t) {
  const previous = { ...process.env };
  const previousPluginDataDirs = testPluginDataDirs;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CODEX_COMPANION_") || ["CLAUDE_PLUGIN_DATA", "CLAUDE_ENV_FILE", "CLAUDE_SESSION_ID", "CLAUDE_TRANSCRIPT_PATH"].includes(key)) {
      delete process.env[key];
    }
  }
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  testPluginDataDirs = new Set([process.env.CLAUDE_PLUGIN_DATA]);
  const pluginDataDirs = testPluginDataDirs;
  t.after(async () => {
    try {
      for (const dir of pluginDataDirs) await shutdownTestBrokers(dir);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      testPluginDataDirs = previousPluginDataDirs;
    }
  });
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  const pluginDataDir = (options.env ?? process.env).CLAUDE_PLUGIN_DATA;
  if (pluginDataDir) testPluginDataDirs?.add(pluginDataDir);
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
