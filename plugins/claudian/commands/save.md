---
description: Save a note to the Obsidian vault
argument-hint: "[KEEP|公開用|アーカイブ] [内容の説明]"
allowed-tools: Bash(node:*)
---

Save the current conversation context or the user's specified content to the Obsidian vault using the `claudian:obsidian-save` skill.

Folder selection:
- Default (no keyword) → inbox
- `KEEP` or `設計原本` → keep
- `公開用` → public
- `アーカイブ` → archive

Generate a concise Japanese title and 2–4 relevant tags automatically.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/obsidian-save.mjs" \
  --title "<生成した日本語タイトル>" \
  --content "<保存する内容>" \
  --folder <inbox|keep|public|archive> \
  --tags "<タグ1,タグ2>"
```

The vault (`田中雄一郎OS保管庫`) is resolved per machine by the script itself —
never pass `--vault` unless the user gives an explicit path.

Report the result as: `保存しました：<filename>`

If the command exits non-zero, report its error message as-is instead.

Raw user request:
$ARGUMENTS
