import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, run } from "./helpers.mjs";
import {
  DEFAULT_FOLDERS,
  DEFAULT_VAULT_NAME,
  VAULT_CONFIG_FILENAME,
  listFolders,
  lookupFolder,
  normalizeFolderPath,
  parseArgs,
  renderNote,
  resolveFolders,
  resolveVaultRoot,
  saveNote,
  today,
  uniqueFilePath
} from "../plugins/claudian/scripts/obsidian-save.mjs";

const SCRIPT = path.resolve("plugins/claudian/scripts/obsidian-save.mjs");

function makeVault(vaultName = DEFAULT_VAULT_NAME) {
  const home = makeTempDir("claudian-home-");
  const root = path.join(home, "TANAKA-BRAIN", vaultName);
  fs.mkdirSync(root, { recursive: true });
  return { home, root };
}

test("saveNote writes a dated note with frontmatter into the requested folder", () => {
  const { home, root } = makeVault();

  const result = saveNote(
    ["--title", "設計方針の決定", "--content", "本文", "--folder", "keep", "--tags", "設計, 決定"],
    { env: {}, home, now: new Date(2026, 7, 6, 7, 0, 0) }
  );

  assert.equal(result.vaultRoot, root);
  assert.equal(result.folder, "02_KEEP");
  assert.equal(path.basename(result.filePath), "2026-08-06_設計方針の決定.md");
  assert.equal(
    fs.readFileSync(result.filePath, "utf8"),
    '---\ndate: 2026-08-06\ntags: ["設計", "決定"]\n---\n\n# 設計方針の決定\n\n本文\n'
  );
});

test("saveNote defaults to the inbox folder", () => {
  const { home } = makeVault();

  const result = saveNote(["--title", "メモ", "--content", "本文"], { env: {}, home });

  assert.equal(result.folder, "00_INBOX");
});

test("saveNote never overwrites a same-day note with the same title", () => {
  const { home } = makeVault();
  const options = { env: {}, home, now: new Date(2026, 7, 6, 12, 0, 0) };

  const first = saveNote(["--title", "メモ", "--content", "一回目"], options);
  const second = saveNote(["--title", "メモ", "--content", "二回目"], options);

  assert.equal(path.basename(first.filePath), "2026-08-06_メモ.md");
  assert.equal(path.basename(second.filePath), "2026-08-06_メモ_2.md");
  assert.match(fs.readFileSync(first.filePath, "utf8"), /一回目/);
  assert.match(fs.readFileSync(second.filePath, "utf8"), /二回目/);
});

test("saveNote strips path separators from the title", () => {
  const { home } = makeVault();

  const result = saveNote(["--title", "A/B:C", "--content", "本文"], {
    env: {},
    home,
    now: new Date(2026, 7, 6, 12, 0, 0)
  });

  assert.equal(path.basename(result.filePath), "2026-08-06_A_B_C.md");
});

test("saveNote rejects missing arguments and unknown folders", () => {
  const { home } = makeVault();

  assert.throws(() => saveNote(["--title", "メモ"], { env: {}, home }), /--title と --content は必須です/);
  assert.throws(
    () => saveNote(["--title", "メモ", "--content", "本文", "--folder", "keeps"], { env: {}, home }),
    /--folder に未登録の名前が指定されました: keeps[\s\S]*inbox \/ keep \/ public \/ archive/
  );
});

test("saveNote fails instead of creating a stray vault directory", () => {
  const home = makeTempDir("claudian-home-");
  const missing = path.join(home, "どこかの保管庫");

  assert.throws(
    () => saveNote(["--title", "メモ", "--content", "本文", "--vault", missing], { env: {}, home }),
    /保管庫のパスが存在しません/
  );
  assert.equal(fs.existsSync(missing), false);

  const created = saveNote(["--title", "メモ", "--content", "本文", "--vault", missing, "--create-vault"], {
    env: {},
    home
  });
  assert.equal(created.vaultRoot, missing);
  assert.equal(fs.existsSync(created.filePath), true);
});

test("saveNote reports every searched location when auto-detection fails", () => {
  const home = makeTempDir("claudian-home-");

  assert.throws(
    () => saveNote(["--title", "メモ", "--content", "本文"], { env: {}, home }),
    (error) =>
      /保管庫が見つかりません/.test(error.message) &&
      error.message.includes(path.join(home, "TANAKA-BRAIN", DEFAULT_VAULT_NAME)) &&
      error.message.includes("CLAUDIAN_VAULT_ROOT")
  );
});

test("resolveVaultRoot honours --vault, the env var, the config file, then auto-detection", () => {
  const { home, root } = makeVault();
  const explicit = makeTempDir("claudian-explicit-");
  const fromEnv = makeTempDir("claudian-env-");
  const fromConfig = makeTempDir("claudian-config-");

  fs.mkdirSync(path.join(home, ".claudian"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claudian", "config.json"), JSON.stringify({ vaultRoot: fromConfig }), "utf8");

  const env = { CLAUDIAN_VAULT_ROOT: fromEnv };

  assert.equal(resolveVaultRoot({ explicit, env, home }).root, explicit);
  assert.equal(resolveVaultRoot({ env, home }).root, fromEnv);
  assert.equal(resolveVaultRoot({ env: {}, home }).root, fromConfig);

  fs.rmSync(path.join(home, ".claudian"), { recursive: true, force: true });
  const detected = resolveVaultRoot({ env: {}, home });
  assert.equal(detected.root, root);
  assert.equal(detected.source, "自動検出");
});

test("resolveVaultRoot expands ~ and honours CLAUDIAN_VAULT_NAME", () => {
  const home = makeTempDir("claudian-home-");
  const named = path.join(home, "Documents", "別の保管庫");
  fs.mkdirSync(named, { recursive: true });

  assert.equal(
    resolveVaultRoot({ env: { CLAUDIAN_VAULT_ROOT: "~/Documents/別の保管庫" }, home }).root,
    named
  );
  assert.equal(resolveVaultRoot({ env: { CLAUDIAN_VAULT_NAME: "別の保管庫" }, home }).root, named);
});

test("resolveVaultRoot reads vaultRoot from CLAUDIAN_CONFIG", () => {
  const home = makeTempDir("claudian-home-");
  const configFile = path.join(makeTempDir("claudian-cfg-"), "claudian.json");
  const vault = makeTempDir("claudian-vault-");
  fs.writeFileSync(configFile, JSON.stringify({ vaultRoot: vault }), "utf8");

  const resolved = resolveVaultRoot({ env: { CLAUDIAN_CONFIG: configFile }, home });

  assert.equal(resolved.root, vault);
  assert.equal(resolved.source, configFile);
});

test("resolveVaultRoot surfaces an unreadable config file", () => {
  const home = makeTempDir("claudian-home-");
  fs.mkdirSync(path.join(home, ".claudian"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claudian", "config.json"), "{ not json", "utf8");

  assert.throws(() => resolveVaultRoot({ env: {}, home }), /設定ファイルを読めませんでした/);
});

test("parseArgs rejects unknown options", () => {
  assert.throws(() => parseArgs(["--foldr", "keep"]), /不明なオプションです: --foldr/);
});

test("today uses the local calendar date", () => {
  assert.equal(today(new Date(2026, 0, 1, 0, 30, 0)), "2026-01-01");
  assert.equal(today(new Date(2026, 11, 31, 23, 59, 0)), "2026-12-31");
});

test("renderNote emits an empty tag list when no tags are given", () => {
  assert.match(renderNote({ title: "T", content: "C", date: "2026-08-06" }), /^tags: \[\]$/m);
});

test("uniqueFilePath keeps counting past an existing suffix", () => {
  const dir = makeTempDir("claudian-notes-");
  fs.writeFileSync(path.join(dir, "note.md"), "", "utf8");
  fs.writeFileSync(path.join(dir, "note_2.md"), "", "utf8");

  assert.equal(uniqueFilePath(dir, "note"), path.join(dir, "note_3.md"));
});

function writeConfig(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data), "utf8");
}

test("resolveFolders starts from the built-in mapping", () => {
  const { home, root } = makeVault();

  const { folders, sources } = resolveFolders({ vaultRoot: root, env: {}, home });

  assert.deepEqual(folders, DEFAULT_FOLDERS);
  assert.deepEqual(sources, ["デフォルト"]);
});

test("a reorganised vault carries its own folder mapping", () => {
  const { home, root } = makeVault();
  writeConfig(path.join(root, VAULT_CONFIG_FILENAME), {
    folders: { inbox: "10_受信", project: "20_進行中/2026", archive: null }
  });

  const { folders, sources } = resolveFolders({ vaultRoot: root, env: {}, home });

  assert.deepEqual(folders, { inbox: "10_受信", keep: "02_KEEP", public: "03_PUBLIC", project: "20_進行中/2026" });
  assert.deepEqual(sources, ["デフォルト", path.join(root, VAULT_CONFIG_FILENAME)]);
});

test("the vault mapping wins over the per-machine one", () => {
  const { home, root } = makeVault();
  writeConfig(path.join(home, ".claudian", "config.json"), { folders: { inbox: "99_ローカル", note: "50_NOTE" } });
  writeConfig(path.join(root, VAULT_CONFIG_FILENAME), { folders: { inbox: "10_受信" } });

  const { folders } = resolveFolders({ vaultRoot: root, env: {}, home });

  assert.equal(folders.inbox, "10_受信");
  assert.equal(folders.note, "50_NOTE");
});

test("saveNote follows the reorganised mapping, including new aliases", () => {
  const { home, root } = makeVault();
  writeConfig(path.join(root, VAULT_CONFIG_FILENAME), { folders: { project: "20_進行中/2026" } });
  const options = { env: {}, home, now: new Date(2026, 7, 6, 12, 0, 0) };

  const result = saveNote(["--title", "進行メモ", "--content", "本文", "--folder", "project"], options);

  assert.equal(result.folder, "20_進行中/2026");
  assert.equal(fs.existsSync(path.join(root, "20_進行中", "2026", "2026-08-06_進行メモ.md")), true);
});

test("saveNote rejects an alias the reorganisation removed", () => {
  const { home, root } = makeVault();
  writeConfig(path.join(root, VAULT_CONFIG_FILENAME), { folders: { archive: null } });

  assert.throws(
    () => saveNote(["--title", "メモ", "--content", "本文", "--folder", "archive"], { env: {}, home }),
    /--folder に未登録の名前が指定されました: archive/
  );
  assert.equal(fs.existsSync(path.join(root, "99_ARCHIVE")), false);
});

test("folder aliases are matched case-insensitively", () => {
  const { home } = makeVault();

  const result = saveNote(["--title", "メモ", "--content", "本文", "--folder", "KEEP"], { env: {}, home });

  assert.equal(result.folder, "02_KEEP");
  assert.equal(lookupFolder(DEFAULT_FOLDERS, " Public "), "03_PUBLIC");
  assert.equal(lookupFolder(DEFAULT_FOLDERS, "missing"), null);
});

test("--dir writes to a literal vault subdirectory, bypassing the mapping", () => {
  const { home, root } = makeVault();

  const result = saveNote(["--title", "メモ", "--content", "本文", "--dir", "30_再編中/下書き"], {
    env: {},
    home,
    now: new Date(2026, 7, 6, 12, 0, 0)
  });

  assert.equal(result.folder, "30_再編中/下書き");
  assert.equal(fs.existsSync(path.join(root, "30_再編中", "下書き", "2026-08-06_メモ.md")), true);
});

test("folder paths cannot escape the vault", () => {
  const { home, root } = makeVault();

  assert.throws(
    () => saveNote(["--title", "メモ", "--content", "本文", "--dir", "../外"], { env: {}, home }),
    /--dir は保管庫内の相対パスにしてください/
  );
  assert.throws(
    () => saveNote(["--title", "メモ", "--content", "本文", "--dir", "/tmp/外"], { env: {}, home }),
    /--dir は保管庫内の相対パスにしてください/
  );
  assert.equal(fs.existsSync(path.join(path.dirname(root), "外")), false);

  assert.throws(
    () => normalizeFolderPath("a/../b", { label: "folders.x", source: "config" }),
    /folders\.x は保管庫内の相対パスにしてください/
  );
  assert.equal(normalizeFolderPath("./01_A/", { label: "folders.x", source: "config" }), "01_A");
});

test("a malformed folders block is reported with its file", () => {
  const { home, root } = makeVault();
  const vaultConfig = path.join(root, VAULT_CONFIG_FILENAME);

  writeConfig(vaultConfig, { folders: ["00_INBOX"] });
  assert.throws(
    () => resolveFolders({ vaultRoot: root, env: {}, home }),
    new RegExp(`${vaultConfig.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")} の folders はオブジェクトで指定してください`)
  );

  writeConfig(vaultConfig, { folders: { keep: 7 } });
  assert.throws(() => resolveFolders({ vaultRoot: root, env: {}, home }), /folders\.keep は空でない文字列にしてください/);
});

test("listFolders reports the mapping and where it came from", () => {
  const { home, root } = makeVault();
  writeConfig(path.join(root, VAULT_CONFIG_FILENAME), { folders: { inbox: "10_受信" } });

  const listed = listFolders(["--list-folders"], { env: {}, home });

  assert.equal(listed.vaultRoot, root);
  assert.equal(listed.folders.inbox, "10_受信");
  assert.deepEqual(listed.sources, ["デフォルト", path.join(root, VAULT_CONFIG_FILENAME)]);
});

test("the CLI prints the resolved mapping for --list-folders", () => {
  const { home, root } = makeVault();
  writeConfig(path.join(root, VAULT_CONFIG_FILENAME), { folders: { inbox: "10_受信" } });

  const result = run(process.execPath, [SCRIPT, "--list-folders"], {
    env: { ...process.env, HOME: home, CLAUDIAN_VAULT_ROOT: root, CLAUDIAN_CONFIG: path.join(home, "absent.json") }
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /inbox\s+→ 10_受信/);
  assert.match(result.stdout, /keep\s+→ 02_KEEP/);
});

test("the CLI prints the filename on stdout and the vault on stderr", () => {
  const { home, root } = makeVault();

  const result = run(process.execPath, [SCRIPT, "--title", "メモ", "--content", "本文", "--folder", "public"], {
    env: { ...process.env, HOME: home, CLAUDIAN_VAULT_ROOT: root }
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout.trim(), /^\d{4}-\d{2}-\d{2}_メモ\.md$/);
  assert.match(result.stderr, new RegExp(`保管庫: ${root}/03_PUBLIC \\(CLAUDIAN_VAULT_ROOT\\)`));
  assert.equal(fs.existsSync(path.join(root, "03_PUBLIC", result.stdout.trim())), true);
});

test("the CLI exits non-zero with a fixable message when the vault is missing", () => {
  const home = makeTempDir("claudian-home-");

  const result = run(process.execPath, [SCRIPT, "--title", "メモ", "--content", "本文"], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDIAN_VAULT_ROOT: "",
      CLAUDIAN_CONFIG: path.join(home, "absent.json")
    }
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim(), "");
  assert.match(result.stderr, /保管庫が見つかりません/);
});
