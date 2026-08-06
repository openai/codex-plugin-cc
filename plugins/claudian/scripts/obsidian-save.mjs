#!/usr/bin/env node
/**
 * Saves a markdown note to the Obsidian vault (default: 田中雄一郎OS保管庫).
 *
 * Usage:
 *   node obsidian-save.mjs --title "タイトル" --content "内容"
 *     [--folder inbox|keep|public|archive] [--tags "タグ1,タグ2"]
 *     [--dir 01_PROJECT/進行中] [--vault /path/to/保管庫] [--create-vault]
 *   node obsidian-save.mjs --list-folders
 *
 * The vault location is resolved per machine so the same plugin works on every
 * Mac without editing this file. Resolution order:
 *   1. --vault
 *   2. CLAUDIAN_VAULT_ROOT
 *   3. vaultRoot in ~/.claudian/config.json (override with CLAUDIAN_CONFIG)
 *   4. auto-detection of CLAUDIAN_VAULT_NAME (default 田中雄一郎OS保管庫)
 *      under the usual parents (~/TANAKA-BRAIN, ~, ~/Documents, iCloud, ...)
 *
 * The folder mapping is data, not code, so reorganising the vault needs no
 * change here. Layers merge in this order (later wins, per alias):
 *   1. the built-in defaults below
 *   2. "folders" in ~/.claudian/config.json          (per machine)
 *   3. "folders" in <vault>/.claudian.json           (travels with the vault)
 * A null value removes an alias. --dir writes to a literal vault subdirectory
 * and bypasses the mapping entirely.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const DEFAULT_VAULT_NAME = "田中雄一郎OS保管庫";

export const DEFAULT_FOLDERS = {
  inbox: "00_INBOX",
  keep: "02_KEEP",
  public: "03_PUBLIC",
  archive: "99_ARCHIVE"
};

export const VAULT_CONFIG_FILENAME = ".claudian.json";

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
    join(home, vaultName),
    // Legacy layout, kept last-resort on purpose: an old copy restored from the
    // Trash must never outrank the vault that actually sits in the home folder.
    join(home, "TANAKA-BRAIN", vaultName),
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

function readJsonFile(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `設定ファイルを読めませんでした: ${filePath}\n${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function resolveVaultRoot({ explicit = null, env = process.env, home = homedir() } = {}) {
  const vaultName = env.CLAUDIAN_VAULT_NAME?.trim() || DEFAULT_VAULT_NAME;

  if (explicit) {
    return { root: expandHome(explicit, home), source: "--vault", vaultName };
  }

  const fromEnv = env.CLAUDIAN_VAULT_ROOT?.trim();
  if (fromEnv) {
    return { root: expandHome(fromEnv, home), source: "CLAUDIAN_VAULT_ROOT", vaultName };
  }

  const userConfigPath = configFilePath(env, home);
  const userConfig = readJsonFile(userConfigPath);
  const vaultRoot = userConfig?.vaultRoot;
  if (vaultRoot != null && vaultRoot !== "") {
    if (typeof vaultRoot !== "string") {
      throw new Error(`${userConfigPath} の vaultRoot は文字列で指定してください。`);
    }
    return { root: expandHome(vaultRoot, home), source: userConfigPath, vaultName };
  }

  const candidates = vaultCandidates(vaultName, home);
  const matches = candidates.filter(isDirectory);
  if (matches.length > 0) {
    // Duplicates and restored backups are common while a vault is being
    // reorganised, so report the ones that lost rather than picking silently.
    return { root: matches[0], source: "自動検出", vaultName, alternatives: matches.slice(1) };
  }

  return { root: null, source: null, vaultName, candidates };
}

export function normalizeFolderPath(value, { label, source }) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${source} の ${label} は空でない文字列にしてください。`);
  }

  const normalized = value.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  const segments = normalized.split("/");

  if (isAbsolute(normalized) || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${source} の ${label} は保管庫内の相対パスにしてください: ${value}`);
  }

  return normalized;
}

/**
 * Merges the folder-alias layers. Vault-local config wins so a reorganisation
 * of 田中雄一郎OS保管庫 reaches every machine through the vault itself.
 */
export function resolveFolders({ vaultRoot = null, env = process.env, home = homedir() } = {}) {
  const folders = { ...DEFAULT_FOLDERS };
  const sources = ["デフォルト"];

  const layers = [];
  const userConfigPath = configFilePath(env, home);
  layers.push({ path: userConfigPath, data: readJsonFile(userConfigPath) });
  if (vaultRoot) {
    const vaultConfigPath = join(vaultRoot, VAULT_CONFIG_FILENAME);
    layers.push({ path: vaultConfigPath, data: readJsonFile(vaultConfigPath) });
  }

  for (const layer of layers) {
    const overrides = layer.data?.folders;
    if (overrides == null) {
      continue;
    }
    if (typeof overrides !== "object" || Array.isArray(overrides)) {
      throw new Error(`${layer.path} の folders はオブジェクトで指定してください。`);
    }

    for (const [alias, value] of Object.entries(overrides)) {
      const key = alias.trim();
      if (key === "") {
        throw new Error(`${layer.path} の folders に空のキーがあります。`);
      }
      if (value === null) {
        delete folders[key];
        continue;
      }
      folders[key] = normalizeFolderPath(value, { label: `folders.${key}`, source: layer.path });
    }

    sources.push(layer.path);
  }

  return { folders, sources };
}

export function lookupFolder(folders, alias) {
  const wanted = String(alias ?? "").trim().toLowerCase();
  const match = Object.entries(folders).find(([key]) => key.toLowerCase() === wanted);
  return match ? match[1] : null;
}

export function parseArgs(args) {
  const result = {
    title: "",
    content: "",
    folder: "inbox",
    tags: [],
    dir: null,
    vault: null,
    createVault: false,
    listFolders: false,
    scanFolders: false,
    write: false
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--title") {
      result.title = args[++i] ?? "";
    } else if (arg === "--content") {
      result.content = args[++i] ?? "";
    } else if (arg === "--folder") {
      result.folder = args[++i] ?? "inbox";
    } else if (arg === "--dir") {
      result.dir = args[++i] ?? "";
    } else if (arg === "--tags") {
      result.tags = (args[++i] ?? "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
    } else if (arg === "--vault") {
      result.vault = args[++i] ?? "";
    } else if (arg === "--create-vault") {
      result.createVault = true;
    } else if (arg === "--list-folders") {
      result.listFolders = true;
    } else if (arg === "--scan-folders") {
      result.scanFolders = true;
    } else if (arg === "--write") {
      result.write = true;
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

function requireVault({ explicit, createVault, env, home }) {
  const resolved = resolveVaultRoot({ explicit, env, home });
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

  return resolved;
}

export function listFolders(argv, { env = process.env, home = homedir() } = {}) {
  const { vault, createVault } = parseArgs(argv);
  const resolved = requireVault({ explicit: vault, createVault, env, home });
  const { folders, sources } = resolveFolders({ vaultRoot: resolved.root, env, home });

  return {
    vaultRoot: resolved.root,
    source: resolved.source,
    alternatives: resolved.alternatives ?? [],
    folders,
    sources
  };
}

/**
 * Turns a directory name into a short alias: "20_進行中" → "進行中",
 * "03_PUBLIC" → "public".
 */
export function deriveAlias(directoryName) {
  const withoutPrefix = directoryName.replace(/^[0-9]+[ _-]*/, "").trim() || directoryName;
  return /^[\x20-\x7E]+$/.test(withoutPrefix) ? withoutPrefix.toLowerCase().replace(/\s+/g, "-") : withoutPrefix;
}

/**
 * Reads the vault as it actually is and proposes a folders block for it, so a
 * reorganisation can be captured without typing the new structure by hand.
 */
export function scanFolders(argv, { env = process.env, home = homedir() } = {}) {
  const { vault, createVault, write } = parseArgs(argv);
  const resolved = requireVault({ explicit: vault, createVault, env, home });
  const { folders: live } = resolveFolders({ vaultRoot: resolved.root, env, home });

  const directories = readdirSync(resolved.root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "ja"));

  const proposed = {};
  const covered = new Set();
  const stale = [];

  for (const [alias, directory] of Object.entries(live)) {
    if (isDirectory(join(resolved.root, directory))) {
      proposed[alias] = directory;
      covered.add(directory.split("/")[0]);
    } else {
      // Keep the alias listed but disabled: a folder the reorganisation
      // removed must stop being a save target, not be recreated on next save.
      proposed[alias] = null;
      stale.push(alias);
    }
  }

  const added = [];
  for (const directory of directories) {
    if (covered.has(directory)) {
      continue;
    }
    let alias = deriveAlias(directory);
    if (Object.hasOwn(proposed, alias)) {
      alias = directory;
    }
    proposed[alias] = directory;
    covered.add(directory);
    added.push(alias);
  }

  const configPath = join(resolved.root, VAULT_CONFIG_FILENAME);
  if (write) {
    const existing = readJsonFile(configPath) ?? {};
    writeFileSync(configPath, `${JSON.stringify({ ...existing, folders: proposed }, null, 2)}\n`, "utf8");
  }

  return {
    vaultRoot: resolved.root,
    source: resolved.source,
    alternatives: resolved.alternatives ?? [],
    configPath,
    directories,
    proposed,
    added,
    stale,
    written: write
  };
}

export function saveNote(argv, { env = process.env, home = homedir(), now = new Date() } = {}) {
  const { title, content, folder, tags, dir, vault, createVault } = parseArgs(argv);

  if (!title || !content) {
    throw new Error("--title と --content は必須です。");
  }

  const resolved = requireVault({ explicit: vault, createVault, env, home });
  const { folders } = resolveFolders({ vaultRoot: resolved.root, env, home });

  let relativeDir;
  if (dir != null) {
    relativeDir = normalizeFolderPath(dir, { label: "--dir", source: "コマンドライン" });
  } else {
    relativeDir = lookupFolder(folders, folder);
    if (!relativeDir) {
      throw new Error(
        [
          `--folder に未登録の名前が指定されました: ${folder}`,
          `使える名前: ${Object.keys(folders).join(" / ") || "(なし)"}`,
          "保管庫内の任意のフォルダに保存する場合は --dir を使ってください。"
        ].join("\n")
      );
    }
  }

  const dirPath = join(resolved.root, relativeDir);
  mkdirSync(dirPath, { recursive: true });

  const date = today(now);
  const filePath = uniqueFilePath(dirPath, `${date}_${sanitizeTitle(title)}`);
  writeFileSync(filePath, renderNote({ title, content, tags, date }), "utf8");

  return {
    filePath,
    vaultRoot: resolved.root,
    source: resolved.source,
    alternatives: resolved.alternatives ?? [],
    folder: relativeDir
  };
}

const WIDE_CHARACTER = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;

function displayWidth(text) {
  let width = 0;
  for (const character of text) {
    width += WIDE_CHARACTER.test(character) ? 2 : 1;
  }
  return width;
}

function warnAboutAlternatives(alternatives) {
  if (!alternatives || alternatives.length === 0) {
    return;
  }
  console.error(`注意: 保管庫の候補が ${alternatives.length + 1} 件見つかりました。使わなかったもの:`);
  for (const alternative of alternatives) {
    console.error(`  - ${alternative}`);
  }
  console.error("こちらが正しい場合は CLAUDIAN_VAULT_ROOT で固定してください。");
}

function main() {
  try {
    const argv = process.argv.slice(2);

    if (argv.includes("--scan-folders")) {
      const scan = scanFolders(argv);
      console.log(`保管庫: ${scan.vaultRoot} (${scan.source})`);
      warnAboutAlternatives(scan.alternatives);
      console.log(`検出したフォルダ (${scan.directories.length}):`);
      for (const directory of scan.directories) {
        console.log(`  ${directory}`);
      }
      console.log("");
      console.log(JSON.stringify({ folders: scan.proposed }, null, 2));
      console.log("");
      if (scan.added.length > 0) {
        console.log(`新しく別名を付けた: ${scan.added.join(" / ")}`);
      }
      if (scan.stale.length > 0) {
        console.log(`フォルダが無い別名 (null で無効化): ${scan.stale.join(" / ")}`);
      }
      console.log(
        scan.written ? `書き込みました: ${scan.configPath}` : `--write を付けると ${scan.configPath} に保存します。`
      );
      return;
    }

    if (argv.includes("--list-folders")) {
      const { vaultRoot, source, alternatives, folders, sources } = listFolders(argv);
      console.log(`保管庫: ${vaultRoot} (${source})`);
      warnAboutAlternatives(alternatives);
      console.log(`フォルダ定義: ${sources.join(" → ")}`);
      const width = Math.max(0, ...Object.keys(folders).map(displayWidth));
      for (const [alias, directory] of Object.entries(folders)) {
        console.log(`  ${alias}${" ".repeat(width - displayWidth(alias))} → ${directory}`);
      }
      return;
    }

    const { filePath, vaultRoot, source, alternatives, folder } = saveNote(argv);
    console.error(`保管庫: ${vaultRoot}/${folder} (${source})`);
    warnAboutAlternatives(alternatives);
    console.log(basename(filePath));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
