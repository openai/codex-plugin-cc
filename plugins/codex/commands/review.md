---
description: Run a Codex code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Codex review through the shared built-in reviewer.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review in a Claude background task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not add extra review instructions or rewrite the user's intent.
- The companion script parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- `/codex:review` is native-review only. It does not support staged-only review, unstaged-only review, or extra focus text.
- If the user needs custom review instructions or more adversarial framing, they should use `/codex:adversarial-review`.

Foreground flow:
- Run the review. The node wrapper streams output in real-time, creates `~/.codex` if needed, saves output only on success, and propagates the exit code:
```bash
node -e "const {spawn,spawnSync:ss}=require('child_process'),os=require('os'),fs=require('fs'),c=require('crypto'),path=require('path');let t;try{t=ss('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).stdout.trim()}catch(e){t=''};const h=t?c.createHash('md5').update(t).digest('hex'):'global';const d=os.homedir()+'/.codex';try{fs.mkdirSync(d,{recursive:true})}catch(e){};const args=process.argv.slice(2).filter(Boolean);const child=spawn(process.execPath,[path.resolve(process.env.CLAUDE_PLUGIN_ROOT,'scripts/codex-companion.mjs'),'review',...args],{stdio:['inherit','pipe','inherit'],env:process.env});const chunks=[];child.stdout.on('data',chunk=>{process.stdout.write(chunk);chunks.push(chunk)});child.on('close',code=>{if(code===0)try{fs.writeFileSync(path.join(d,'last-review-'+h+'.md'),Buffer.concat(chunks))}catch(e){};process.exit(code??1)});" -- "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch the review with `Bash` in the background. Same streaming node wrapper as the foreground flow:
```typescript
Bash({
  command: `node -e "const {spawn,spawnSync:ss}=require('child_process'),os=require('os'),fs=require('fs'),c=require('crypto'),path=require('path');let t;try{t=ss('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).stdout.trim()}catch(e){t=''};const h=t?c.createHash('md5').update(t).digest('hex'):'global';const d=os.homedir()+'/.codex';try{fs.mkdirSync(d,{recursive:true})}catch(e){};const args=process.argv.slice(2).filter(Boolean);const child=spawn(process.execPath,[path.resolve(process.env.CLAUDE_PLUGIN_ROOT,'scripts/codex-companion.mjs'),'review',...args],{stdio:['inherit','pipe','inherit'],env:process.env});const chunks=[];child.stdout.on('data',chunk=>{process.stdout.write(chunk);chunks.push(chunk)});child.on('close',code=>{if(code===0)try{fs.writeFileSync(path.join(d,'last-review-'+h+'.md'),Buffer.concat(chunks))}catch(e){};process.exit(code??1)});" -- "$ARGUMENTS"`,
  description: "Codex review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "Codex review started in the background. Check `/codex:status` for progress."
