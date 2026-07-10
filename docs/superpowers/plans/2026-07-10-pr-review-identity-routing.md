# PR Review Identity and Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address both unresolved PR review threads by renaming the installed relay to `codex-relay` and expanding GPT-5.6 routing into a referenced policy bundle.

**Architecture:** Keep the physical `plugins/codex` tree and runtime unchanged while replacing every installed identity and namespaced reference at the manifest, documentation, prompt, runtime-message, and test boundaries. Keep routing logic in the internal skill: `SKILL.md` orchestrates three focused references, and no classification moves into Node.

**Tech Stack:** Claude Code plugin Markdown/YAML, JSON manifests, Node.js ESM, `node:test`, npm, GitHub PR review threads.

## Global Constraints

- Marketplace name: `codex-cc-relay`.
- Marketplace owner and plugin author: `hotaru-ritsuki`.
- Plugin manifest name: `codex-relay`.
- Slash-command namespace: `/codex-relay:*`.
- Agent and skill namespace: `codex-relay:*`.
- Private package name: `@hotaru-ritsuki/codex-cc-relay-plugin`.
- Keep the physical plugin directory `plugins/codex`.
- Remove the old `/codex:*` and `codex:*` namespaces; do not add aliases.
- Keep version `1.1.6` and preserve upstream history, Apache-2.0, state schema, runtime behavior, and approved feature scope.
- Keep `@openai/codex` references that install or describe the separate Codex CLI.
- Routing remains fresh-only, Fable-owned, static, and separate from prompt shaping.
- Do not reply to or resolve GitHub review threads without explicit user authorization.

---

## Task 1: Rename the Installed Relay Identity

**Files**

- Modify: `tests/commands.test.mjs`
- Modify: `tests/bump-version.test.mjs`
- Modify: `tests/runtime.test.mjs`
- Modify: `scripts/bump-version.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `plugins/codex/.claude-plugin/plugin.json`
- Modify: `README.md`
- Modify: `UPSTREAM.md`
- Modify: `plugins/codex/CHANGELOG.md`
- Modify: `plugins/codex/commands/*.md`
- Modify: `plugins/codex/agents/*.md`
- Modify: `plugins/codex/skills/*/SKILL.md`
- Modify: `plugins/codex/prompts/*.md`
- Modify: `plugins/codex/scripts/codex-companion.mjs`
- Modify: `plugins/codex/scripts/stop-review-gate-hook.mjs`
- Modify: `plugins/codex/scripts/lib/*.mjs` where user-facing slash commands appear
- Modify: `docs/superpowers/specs/2026-07-10-codex-cc-relay-plugin-design.md`

**Interfaces**

- Consumes: existing plugin files and behavior at version `1.1.6`.
- Produces: the `codex-relay` installed identity and updated namespaced command/agent/skill contracts.

- [ ] **Step 1: Add failing identity tests**

Add to `tests/commands.test.mjs`:

```js
test("relay manifests and docs use the codex-relay identity", () => {
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"),
  );
  const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  );
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.equal(marketplace.name, "codex-cc-relay");
  assert.equal(marketplace.owner.name, "hotaru-ritsuki");
  assert.equal(marketplace.plugins[0].name, "codex-relay");
  assert.equal(marketplace.plugins[0].author.name, "hotaru-ritsuki");
  assert.equal(plugin.name, "codex-relay");
  assert.equal(plugin.author.name, "hotaru-ritsuki");
  assert.equal(packageJson.name, "@hotaru-ritsuki/codex-cc-relay-plugin");
  assert.match(readme, /\/codex-relay:setup/);
  assert.match(readme, /codex-relay:codex-rescue/);
  assert.doesNotMatch(readme, /\/codex:/);
  assert.doesNotMatch(readme, /codex:codex-/);
});
```

Update existing command-contract expectations from `/codex:*` and `codex:*` to `/codex-relay:*` and `codex-relay:*`.

Update `tests/bump-version.test.mjs` fixtures to use:

```js
name: "@hotaru-ritsuki/codex-cc-relay-plugin"
```

and marketplace/plugin entries named `codex-relay`.

- [ ] **Step 2: Run RED tests**

```powershell
node --test tests/commands.test.mjs tests/bump-version.test.mjs
```

Expected: the new identity test fails on `openai-codex`, `OpenAI`, `codex`, and `@openai/codex-plugin-cc`.

- [ ] **Step 3: Rename manifests, package metadata, and version lookup**

Set `.claude-plugin/marketplace.json` to:

```json
{
  "name": "codex-cc-relay",
  "owner": {
    "name": "hotaru-ritsuki"
  },
  "metadata": {
    "description": "GPT-5.6-aware Codex relay for Claude Code delegation and review.",
    "version": "1.1.6"
  },
  "plugins": [
    {
      "name": "codex-relay",
      "description": "Relay Claude Code tasks and reviews to Codex with GPT-5.6 routing.",
      "version": "1.1.6",
      "author": {
        "name": "hotaru-ritsuki"
      },
      "source": "./plugins/codex"
    }
  ]
}
```

Set `plugins/codex/.claude-plugin/plugin.json` name to `codex-relay`, author to `hotaru-ritsuki`, and use the same plugin description. Rename the root package and both package-lock name fields to `@hotaru-ritsuki/codex-cc-relay-plugin`.

Change `findMarketplacePlugin` in `scripts/bump-version.mjs`:

```js
function findMarketplacePlugin(json) {
  const plugin = json.plugins?.find((entry) => entry?.name === "codex-relay");
  requireObject(plugin, ".claude-plugin/marketplace.json plugins[codex-relay]");
  return plugin;
}
```

- [ ] **Step 4: Rename active namespaced references**

Replace user-facing `/codex:*` commands with `/codex-relay:*` and plugin-qualified `codex:*` references with `codex-relay:*` across the files listed above. Do not alter plain Codex product names, JSON properties named `codex`, the `@openai/codex` CLI package, or the upstream repository URL.

Update README installation:

```markdown
/plugin marketplace add hotaru-ritsuki/codex-cc-relay-plugin
/plugin install codex-relay@codex-cc-relay
```

Update the changelog and active design/provenance text to state that the fork preserves runtime compatibility but deliberately uses its own `codex-relay` identity.

- [ ] **Step 5: Run GREEN identity tests**

```powershell
node --test tests/commands.test.mjs tests/bump-version.test.mjs
npm run check-version -- 1.1.6
```

Expected: all focused tests and version checks pass.

- [ ] **Step 6: Run a stale-identity audit**

```powershell
rg -n -F -e "/codex:" -e "codex:codex-" -e "Skill(codex:" -e '"openai-codex"' -e '"name": "OpenAI"' -e "@openai/codex-plugin-cc" README.md package.json package-lock.json .claude-plugin plugins tests docs/superpowers/specs/2026-07-10-codex-cc-relay-plugin-design.md
```

Expected: no matches. Separately confirm that `rg -n -F "@openai/codex" README.md plugins` still finds legitimate Codex CLI installation guidance.

- [ ] **Step 7: Commit the identity rename**

```powershell
git add .claude-plugin .gitignore README.md UPSTREAM.md package.json package-lock.json scripts plugins tests docs/superpowers/specs/2026-07-10-codex-cc-relay-plugin-design.md
git commit -m "feat: rename plugin to codex-relay"
```

---

## Task 2: Expand GPT-5.6 Routing References

**Files**

- Modify: `tests/commands.test.mjs`
- Modify: `plugins/codex/skills/gpt-5-6-routing/SKILL.md`
- Create: `plugins/codex/skills/gpt-5-6-routing/references/complexity-rubric.md`
- Create: `plugins/codex/skills/gpt-5-6-routing/references/model-effort-policy.md`
- Create: `plugins/codex/skills/gpt-5-6-routing/references/routing-examples.md`

**Interfaces**

- Consumes: the approved fresh-task routing behavior.
- Produces: one concise skill entry point and three separately maintainable reference contracts.

- [ ] **Step 1: Add failing routing-bundle tests**

Replace the single-file routing test with:

```js
test("internal GPT-5.6 routing skill loads its complete policy bundle", () => {
  const routing = read("skills/gpt-5-6-routing/SKILL.md");
  const rubric = read(
    "skills/gpt-5-6-routing/references/complexity-rubric.md",
  );
  const policy = read(
    "skills/gpt-5-6-routing/references/model-effort-policy.md",
  );
  const examples = read(
    "skills/gpt-5-6-routing/references/routing-examples.md",
  );

  assert.match(routing, /user-invocable:\s*false/);
  assert.match(routing, /references\/complexity-rubric\.md/);
  assert.match(routing, /references\/model-effort-policy\.md/);
  assert.match(routing, /references\/routing-examples\.md/);
  assert.match(rubric, /breadth.*ambiguity.*risk.*verification/is);
  assert.doesNotMatch(rubric, /gpt-5\.6-(?:luna|terra|sol)/i);
  assert.match(policy, /gpt-5\.6-luna.*low/s);
  assert.match(policy, /gpt-5\.6-terra.*medium/s);
  assert.match(policy, /gpt-5\.6-sol.*high/s);
  assert.match(policy, /gpt-5\.6-sol.*xhigh/s);
  assert.match(policy, /max.*explicit-only/is);
  assert.match(policy, /cannot decide.*leave.*unset/is);
  assert.match(examples, /partial override/i);
  assert.match(examples, /resume/i);
  assert.match(examples, /insufficient context/i);
});
```

- [ ] **Step 2: Run RED routing test**

```powershell
node --test --test-name-pattern "routing skill loads" tests/commands.test.mjs
```

Expected: failure with `ENOENT` for `complexity-rubric.md`.

- [ ] **Step 3: Refactor the entry-point skill**

Keep the existing frontmatter. Replace the body with a short procedure that:

1. applies only to fresh `/codex-relay:rescue` work;
2. reads `references/complexity-rubric.md` and `references/model-effort-policy.md` before routing;
3. reads `references/routing-examples.md` when a boundary is unclear;
4. classifies only missing values and returns model/effort flags without changing prompt text;
5. leaves a missing value unset when the references do not support a decision.

- [ ] **Step 4: Create the three references**

`complexity-rubric.md` defines the evaluation dimensions and these classes:

- small and bounded: known surface, reversible change, simple verification;
- normal and bounded: limited exploration, a few coordinated files, standard diagnosis and verification;
- broad/ambiguous/high-value: multiple components, meaningful exploration, higher impact, substantial verification;
- architectural/high-risk/unusually difficult: cross-cutting decisions, hard-to-reverse consequences, complex dependencies, or exceptional verification.

It distinguishes a boundary ambiguity, which selects the higher class, from insufficient task information, which produces no classification.

`model-effort-policy.md` contains the authoritative override table, four model/effort rows, fresh-only rule, resume preservation, explicit-only `max`, invalid `ultra`, leave-unset fallback, and prohibition on catalog queries/fallback names.

`routing-examples.md` includes at least eight labeled examples: small, normal, broad, architectural, model-only override, effort-only override, resume, ambiguous boundary, and insufficient context. Each example states the classification and exact missing values that are filled or left unset.

- [ ] **Step 5: Run GREEN routing tests**

```powershell
node --test tests/commands.test.mjs
```

Expected: all command and skill contracts pass.

- [ ] **Step 6: Commit the routing bundle**

```powershell
git add plugins/codex/skills/gpt-5-6-routing tests/commands.test.mjs
git commit -m "docs: expand GPT-5.6 routing policy"
```

---

## Task 3: Final Verification and PR Update

**Files**

- Modify only if verification exposes a defect in Task 1 or Task 2.

**Interfaces**

- Consumes: renamed identity and referenced routing bundle.
- Produces: a pushed PR branch with both review requests implemented.

- [ ] **Step 1: Run focused and static verification**

```powershell
node --test tests/commands.test.mjs tests/bump-version.test.mjs
npm run check-version -- 1.1.6
npx tsc -p tsconfig.app-server.json --noEmit
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Run the aggregate suite**

```powershell
npm test
```

Expected on Linux: zero failures. On this Windows host: no failure beyond the documented upstream Windows baseline names; record the exact summary.

- [ ] **Step 3: Verify the PR diff and push**

```powershell
git status --short
git log --oneline origin/feature/relay-1.1.6..HEAD
git push
gh pr view 1 --repo hotaru-ritsuki/codex-cc-relay-plugin --json headRefOid,url,isDraft
```

Expected: clean worktree, pushed head equals local HEAD, draft PR remains open.

- [ ] **Step 4: Re-read unresolved review threads**

Run the bundled `fetch_comments.py` with `GH_REPO=hotaru-ritsuki/codex-cc-relay-plugin`. Confirm both original threads remain unresolved until the user explicitly authorizes replies/resolution, and report how each diff addresses its request.
