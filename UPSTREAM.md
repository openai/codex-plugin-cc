# Upstream Synchronization

This repository is a compatibility-first relay fork of
https://github.com/openai/codex-plugin-cc.

- Upstream remote: `upstream`
- Upstream release: `v1.0.6`
- Upstream commit: `db52e28`
- Relay release based on it: `v1.1.6`
- Last synchronized: `2026-07-10`

## Sync procedure

1. Ensure `upstream` points to `https://github.com/openai/codex-plugin-cc.git`.
2. Run `git fetch upstream --tags`.
3. Review upstream release notes, issues, and pull requests for the target tag.
4. Merge the selected upstream tag into a dedicated synchronization branch.
5. Resolve conflicts while preserving relay policy in the internal routing and prompting skills.
6. Run `npm test`, `npm run check-version`, and `npm run build`.
7. Update this file with the new upstream tag, exact commit, relay mapping, and date.

The relay keeps the upstream Apache-2.0 license, plugin name, `/codex:*` namespace,
and Git history. `UPSTREAM.md` is authoritative for the exact upstream base.
