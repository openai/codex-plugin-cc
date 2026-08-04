---
name: obsidian-save
description: Save a note or conversation summary to the Obsidian vault
user-invocable: false
---

# Obsidian Save

Use this skill to save content to the user's Obsidian vault.

## When to invoke

Invoke automatically (without asking) when any of these occur:
- An important design decision, policy, or conclusion has been finalized
- A draft reply to 一海 is complete or approved
- The conversation reaches a natural stopping point
- The user says「OK」「これでいい」「完了」「保存して」or similar

## How to save

Run the save script:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/obsidian-save.mjs" \
  --title "日本語タイトル" \
  --content "保存する内容" \
  --folder inbox \
  --tags "タグ1,タグ2"
```

The script outputs the saved filename. Report it to the user as:
`保存しました：<filename>`

Nothing else — no elaboration.

## Folder selection

| User keyword | --folder value |
|---|---|
| (default / none) | inbox |
| KEEP / 設計原本 | keep |
| 公開用 | public |
| アーカイブ | archive |

## Title and tags

- Generate a concise Japanese title that describes the content.
- Generate 2–4 relevant Japanese tags.
- Never ask the user to provide a title or tags.

## Vault path

`/Users/nesty/TANAKA-BRAIN/田中雄一郎OS保管庫/`

| folder value | directory |
|---|---|
| inbox | 00_INBOX |
| keep | 02_KEEP |
| public | 03_PUBLIC |
| archive | 99_ARCHIVE |
