# claudian

Obsidian integration for Claude Code. Saves conversation notes and decisions to
the Obsidian vault **田中雄一郎OS保管庫**.

## Usage

```
/claudian:save                      # → 00_INBOX
/claudian:save KEEP 設計方針         # → 02_KEEP
/claudian:save 公開用 記事の下書き     # → 03_PUBLIC
/claudian:save アーカイブ 旧メモ       # → 99_ARCHIVE
```

The `obsidian-save` skill also fires on its own when a decision is finalized or
the user says「保存して」「これでいい」.

## Vault layout

Default aliases:

| folder value | directory |
|---|---|
| inbox (default) | `00_INBOX` |
| keep | `02_KEEP` |
| public | `03_PUBLIC` |
| archive | `99_ARCHIVE` |

### 保管庫を再編したとき

The mapping is data, not code — **reorganising the vault needs no change to
this plugin**. Put the new structure in `.claudian.json` at the root of
`田中雄一郎OS保管庫`:

```json
{
  "folders": {
    "inbox": "10_受信",
    "project": "20_進行中/2026",
    "archive": null
  }
}
```

- Only the aliases you list change; the rest keep their defaults.
- `null` removes an alias, so a folder that no longer exists stops being a
  valid save target instead of being silently recreated.
- Values are vault-relative paths (nesting allowed). Absolute paths and `..`
  are rejected.
- Because the file lives **inside the vault**, the M1 and the M5 pick up the
  same reorganisation as soon as the vault syncs. A per-machine `folders`
  block in `~/.claudian/config.json` also works, but the vault's file wins.

Check what is live at any moment:

```bash
node plugins/claudian/scripts/obsidian-save.mjs --list-folders
```

While the structure is still in flux, save straight to a directory without
registering an alias:

```bash
node plugins/claudian/scripts/obsidian-save.mjs --title "…" --content "…" --dir "30_再編中/下書き"
```

Notes are written as `YYYY-MM-DD_タイトル.md` (local date) with `date` and
`tags` frontmatter. A same-day note with the same title never overwrites the
existing one — it becomes `..._2.md`, `..._3.md`, and so on.

## Setup on each Mac

The vault path is **not** hardcoded, so the MacBook Air M1 and the MacBook Air
M5 can keep the vault in different places. The script resolves it in this
order:

1. `--vault <path>` on the command line
2. `CLAUDIAN_VAULT_ROOT` environment variable
3. `vaultRoot` in `~/.claudian/config.json` (path overridable with `CLAUDIAN_CONFIG`)
4. Auto-detection of a directory named `田中雄一郎OS保管庫` under:
   `~/TANAKA-BRAIN`, `~`, `~/Documents`,
   `~/Library/Mobile Documents/iCloud~md~obsidian/Documents`,
   `~/Library/Mobile Documents/com~apple~CloudDocs`, `~/Dropbox`,
   `~/Google Drive`, `~/obsidian`

If the vault lives in one of those places, nothing to configure. Otherwise pin
it once per machine:

```bash
mkdir -p ~/.claudian
cat > ~/.claudian/config.json <<'JSON'
{ "vaultRoot": "~/TANAKA-BRAIN/田中雄一郎OS保管庫" }
JSON
```

or:

```bash
echo 'export CLAUDIAN_VAULT_ROOT="$HOME/TANAKA-BRAIN/田中雄一郎OS保管庫"' >> ~/.zshrc
```

A different vault name can be auto-detected with `CLAUDIAN_VAULT_NAME`.

When the vault cannot be found the save **fails loudly** instead of creating a
stray directory. Pass `--create-vault` only when the vault really should be
created at that path.

## Manual invocation

```bash
node plugins/claudian/scripts/obsidian-save.mjs \
  --title "タイトル" \
  --content "本文" \
  --folder keep \
  --tags "設計,決定"
```

| flag | meaning |
|---|---|
| `--folder <alias>` | Save under a registered alias (default `inbox`). |
| `--dir <相対パス>` | Save under a literal vault subdirectory, ignoring aliases. |
| `--list-folders` | Print the live alias → directory mapping and its sources. |
| `--vault <path>` | Use this vault for one run. |
| `--create-vault` | Create the vault directory if it is missing. |

The saved filename is printed to stdout; the resolved vault directory and how
it was resolved go to stderr.
