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

The vault is being reorganised, so the alias list is **data, not code**: it
lives in `<vault>/.claudian.json` and can gain, rename, or drop entries at any
time. Never assume the table below is current.

| User keyword | --folder value |
|---|---|
| (default / none) | inbox |
| KEEP / 設計原本 | keep |
| 公開用 | public |
| アーカイブ | archive |

Check the live mapping whenever the user names a folder that is not in that
table, or when a save fails with `--folder に未登録の名前が指定されました`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/obsidian-save.mjs" --list-folders
```

Then re-run the save with an alias that actually exists. To write to a folder
that has no alias yet, pass a literal vault-relative path instead:
`--dir "20_進行中/2026"`. Prefer aliases; use `--dir` only when the user named a
specific folder or the reorganisation has not settled.

## Title and tags

- Generate a concise Japanese title that describes the content.
- Generate 2–4 relevant Japanese tags.
- Never ask the user to provide a title or tags.

## Vault path

Save destination: `田中雄一郎OS保管庫`

The script resolves the vault per machine, so the same command works on the
MacBook Air M1 and the MacBook Air M5 even when the vault sits in a different
place. Resolution order:

1. `--vault <path>`
2. `CLAUDIAN_VAULT_ROOT`
3. `vaultRoot` in `~/.claudian/config.json`
4. Auto-detection of `田中雄一郎OS保管庫` under `~` (the real layout:
   `/Users/nesty/田中雄一郎OS保管庫`), then `~/TANAKA-BRAIN` (old layout),
   `~/Documents`, the Obsidian/iCloud Drive folders, `~/Dropbox`, `~/Google Drive`

If several candidates exist, the script uses the first and prints the others on
stderr. Pass that warning on to the user — it usually means a backup or a copy
restored from the Trash is sitting next to the real vault.

Default folder mapping (overridden by `<vault>/.claudian.json`):

| folder value | directory |
|---|---|
| inbox | 00_INBOX |
| keep | 02_KEEP |
| public | 03_PUBLIC |
| archive | 99_ARCHIVE |

## When the save fails

The script exits non-zero and prints what to fix. Do not retry blindly:

- `保管庫が見つかりません` / `保管庫のパスが存在しません` — the vault is not where
  the script looked. Report the message and tell the user to set
  `CLAUDIAN_VAULT_ROOT` (or `~/.claudian/config.json`) on that machine.
- `--folder に未登録の名前が指定されました` — the alias was renamed or removed by
  the reorganisation. Run `--list-folders` and retry with a live alias.
- If the mapping is clearly behind the vault (several aliases point at folders
  that no longer exist), run `--scan-folders` to show the user a draft of the
  current structure. It only prints; adding `--write` changes the vault's
  `.claudian.json`, so ask before running that.
- Never invent a path or pass `--create-vault` on your own; an empty vault
  created in the wrong place looks like a successful save.
