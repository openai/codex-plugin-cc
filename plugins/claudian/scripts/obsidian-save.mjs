#!/usr/bin/env node
/**
 * Saves a markdown note to the Obsidian vault.
 * Usage: node obsidian-save.mjs --title "タイトル" --content "内容" [--folder keep|public|archive]
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const VAULT_ROOT = "/Users/nesty/TANAKA-BRAIN/田中雄一郎OS保管庫";

const FOLDERS = {
  inbox:   "00_INBOX",
  keep:    "02_KEEP",
  public:  "03_PUBLIC",
  archive: "99_ARCHIVE",
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function parseArgs(args) {
  const result = { title: "", content: "", folder: "inbox", tags: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--title")   result.title   = args[++i] ?? "";
    if (args[i] === "--content") result.content = args[++i] ?? "";
    if (args[i] === "--folder")  result.folder  = args[++i] ?? "inbox";
    if (args[i] === "--tags")    result.tags    = (args[++i] ?? "").split(",").map(t => t.trim()).filter(Boolean);
  }
  return result;
}

const { title, content, folder, tags } = parseArgs(process.argv.slice(2));

if (!title || !content) {
  console.error("Error: --title and --content are required.");
  process.exit(1);
}

const folderName = FOLDERS[folder] ?? FOLDERS.inbox;
const dirPath = join(VAULT_ROOT, folderName);
mkdirSync(dirPath, { recursive: true });

const date = today();
const safeName = title.replace(/[/\\:*?"<>|]/g, "_");
const fileName = `${date}_${safeName}.md`;
const filePath = join(dirPath, fileName);

const tagLine = tags.length > 0 ? `[${tags.map(t => `"${t}"`).join(", ")}]` : "[]";

const body = `---
date: ${date}
tags: ${tagLine}
---

# ${title}

${content}
`;

writeFileSync(filePath, body, "utf8");
console.log(fileName);
