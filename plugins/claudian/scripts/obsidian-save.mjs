#!/usr/bin/env node
/**
 * Saves a markdown note to the Obsidian vault (default: 田中雄一郎OS保管庫).
 *
 * Usage:
 *   node obsidian-save.mjs --title "タイトル" --content "内容"
 *     [--folder inbox|keep|public|archive] [--tags "タグ1,タグ2"]
 *     [--vault /path/to/保管庫] [--create-vault]
 *
 * The vault location is resolved per machine so the same plugin works on every
 * Mac without editing this file. Resolution order:
 *   1. --vault
 *   2. CLAUDIAN_VAULT_ROOT
 *   3. vaultRoot in ~/.claudian/config.json (override with CLAUDIAN_CONFIG)
 *   4. auto-detection of CLAUDIAN_VAULT_NAME (default 田中雄一郎OS保管庫)
 *      under the usual parents (~/TANAKA-BRAIN, ~, ~/Documents, iCloud, ...)
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const DEFAULT_VAULT_NAME = "田中雄一郎OS保管庫";

export const FOLDERS = {
  inbox: "00_INBOX",
  keep: "02_KEEP",
  public: "03_PUBLIC",
  archive: "99_ARCHIVE"
};

export function today(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  // Local time on purpose: a JST note saved at 07:00 belongs to that day, not
  // to the previous UTC one.
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function expandHome(filePath, home = homedir()) {
  if (filePath === "~") {
    return home;
  }
  if (filePath.startsWith("~/")) {
    return join(home, filePath.slice(2));
  }
  return isAbsolute(filePath) ? filePath : resolve(filePath);
}

export function configFilePath(env = process.env, home = homedir()) {
  const configured = env.CLAUDIAN_CONFIG?.trim();
  return configured ? expandHome(configured, home) : join(home, ".claudian", "config.json");
}

export function vaultCandidates(vaultName = DEFAULT_VAULT_NAME, home = homedir()) {
  return [
    join(home, "TANAKA-BRAIN", vaultName),
    join(home, vaultName),
    join(home, "Documents", vaultName),
    join(home, "Library", "Mobile Documents", "iCloud~md~obsidian", "Documents", vaultName),
    join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", vaultName),
    join(home, "Dropbox", vaultName),
    join(home, "Google Drive", vaultName),
    join(home, "obsidian", vaultName)
  ];
}

function isDirectory(candidate) {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function readConfiguredRoot(env, home) {
  const filePath = configFilePath(env, home);
  if (!existsSync(filePath)) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`設定ファイルを読めませんでした: ${filePath}\n${error instanceof Error ? error.message : String(error)}`);
  }

  const vaultRoot = parsed?.vaultRoot;
  if (vaultRoot == null || vaultRoot === "") {
    return null;
  }
  if (typeof vaultRoot !== "string") {
    throw new Error(`${filePath} の vaultRoot は文字列で指定してください。`);
  }
  return { root: expandHome(vaultRoot, home), source: filePath };
}

export function resolveVaultRoot({ explicit = null, env = process.env, home = homedir() } = {}) {
  const vaultName = env.CLAUDIAN_VAULT_NAME?.trim() || DEFAULT_VAULT_NAME;

  if (explicit) {
    return { root: expandHome(explicit, home), source: "--vault", vaultName, detected: false };
  }

  const fromEnv = env.CLAUDIAN_VAULT_ROOT?.trim();
  if (fromEnv) {
    return { root: expandHome(fromEnv, home), source: "CLAUDIAN_VAULT_ROOT", vaultName, detected: false };
  }

  const fromConfig = readConfiguredRoot(env, home);
  if (fromConfig) {
    return { root: fromConfig.root, source: fromConfig.source, vaultName, detected: false };
  }

  const candidates = vaultCandidates(vaultName, home);
  const found = candidates.find(isDirectory);
  if (found) {
    return { root: found, source: "自動検出", vaultName, detected: true };
  }

  return { root: null, source: null, vaultName, detected: true, candidates };
}

export function parseArgs(args) {
  const result = { title: "", content: "", folder: "inbox", tags: [], vault: null, createVault: false };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--title") {
      result.title = args[++i] ?? "";
    } else if (arg === "--content") {
      result.content = args[++i] ?? "";
    } else if (arg === "--folder") {
      result.folder = args[++i] ?? "inbox";
    } else if (arg === "--tags") {
      result.tags = (args[++i] ?? "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
    } else if (arg === "--vault") {
      result.vault = args[++i] ?? "";
    } else if (arg === "--create-vault") {
      result.createVault = true;
    } else {
      throw new Error(`不明なオプションです: ${arg}`);
    }
  }

  return result;
}

export function sanitizeTitle(title) {
  return title.replace(/[/\\:*?"<>|]/g, "_").trim();
}

export function uniqueFilePath(dirPath, baseName) {
  let candidate = join(dirPath, `${baseName}.md`);
  for (let counter = 2; existsSync(candidate); counter += 1) {
    candidate = join(dirPath, `${baseName}_${counter}.md`);
  }
  return candidate;
}

export function renderNote({ title, content, tags = [], date = today() }) {
  const tagLine = tags.length > 0 ? `[${tags.map((tag) => `"${tag.replace(/"/g, '\\"')}"`).join(", ")}]` : "[]";
  return `---
date: ${date}
tags: ${tagLine}
---

# ${title}

${content}
`;
}

function missingVaultMessage({ vaultName, candidates }) {
  return [
    `保管庫が見つかりません（探した名前: ${vaultName}）。`,
    "次のいずれかで保存先を指定してください:",
    "  export CLAUDIAN_VAULT_ROOT=\"/Users/<user>/.../田中雄一郎OS保管庫\"",
    "  ~/.claudian/config.json に {\"vaultRoot\": \"...\"} を書く",
    "  node obsidian-save.mjs --vault \"...\" ...",
    "自動検出で確認した場所:",
    ...candidates.map((candidate) => `  - ${candidate}`)
  ].join("\n");
}

export function saveNote(argv, { env = process.env, home = homedir(), now = new Date() } = {}) {
  const { title, content, folder, tags, vault, createVault } = parseArgs(argv);

  if (!title || !content) {
    throw new Error("--title と --content は必須です。");
  }

  if (!Object.hasOwn(FOLDERS, folder)) {
    throw new Error(`--folder は ${Object.keys(FOLDERS).join(" / ")} のいずれかを指定してください: ${folder}`);
  }

  const resolved = resolveVaultRoot({ explicit: vault, env, home });
  if (!resolved.root) {
    throw new Error(missingVaultMessage({ vaultName: resolved.vaultName, candidates: resolved.candidates }));
  }

  if (!isDirectory(resolved.root)) {
    if (!createVault) {
      throw new Error(
        [
          `保管庫のパスが存在しません: ${resolved.root}`,
          `（指定元: ${resolved.source}）`,
          "パスを直すか、新規作成する場合は --create-vault を付けてください。"
        ].join("\n")
      );
    }
    mkdirSync(resolved.root, { recursive: true });
  }

  const dirPath = join(resolved.root, FOLDERS[folder]);
  mkdirSync(dirPath, { recursive: true });

  const date = today(now);
  const filePath = uniqueFilePath(dirPath, `${date}_${sanitizeTitle(title)}`);
  writeFileSync(filePath, renderNote({ title, content, tags, date }), "utf8");

  return { filePath, vaultRoot: resolved.root, source: resolved.source, folder: FOLDERS[folder] };
}

function main() {
  try {
    const { filePath, vaultRoot, source, folder } = saveNote(process.argv.slice(2));
    console.error(`保管庫: ${vaultRoot}/${folder} (${source})`);
    console.log(basename(filePath));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
