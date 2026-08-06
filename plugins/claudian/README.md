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

| folder value | directory |
|---|---|
| inbox (default) | `00_INBOX` |
| keep | `02_KEEP` |
| public | `03_PUBLIC` |
| archive | `99_ARCHIVE` |

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

The saved filename is printed to stdout; the resolved vault directory and how
it was resolved go to stderr.
