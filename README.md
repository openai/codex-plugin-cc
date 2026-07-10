# Codex CC Relay Plugin

Use Codex from inside Claude Code for code reviews or to delegate tasks to Codex.

This compatibility-first relay is built on
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc). See
[`UPSTREAM.md`](./UPSTREAM.md) for the exact upstream base and synchronization procedure.
It preserves upstream runtime compatibility while deliberately using the relay's own
`codex-relay` plugin identity and `/codex-relay:*` command namespace.

The separate `fable-codex-workflow` project owns orchestration and workflow setup. This
repository provides the compatible Codex relay plugin and its runtime policy.

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## What You Get

- `/codex-relay:review` for a normal read-only Codex review
- `/codex-relay:adversarial-review` for a steerable challenge review
- `/codex-relay:rescue`, `/codex-relay:transfer`, `/codex-relay:status`, `/codex-relay:result`, and `/codex-relay:cancel` to delegate work, hand off sessions, and manage background jobs

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**

## Install

Add the relay marketplace, install the plugin, and reload plugins:

```bash
/plugin marketplace add hotaru-ritsuki/codex-cc-relay-plugin
/plugin install codex-relay@codex-cc-relay
/reload-plugins
```

Then run:

```bash
/codex-relay:setup
```

`/codex-relay:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

After install, you should see:

- the slash commands listed below
- the `codex-relay:codex-rescue` and `codex-relay:codex-reviewer` subagents in `/agents`

Claude can proactively delegate an independent review to `codex-relay:codex-reviewer`. The reviewer selects the existing native `review` path for a normal request or `adversarial-review` when the request includes focus text, custom instructions, or adversarial framing. It is read-only, foreground by default, and non-resumable.

One simple first run is:

```bash
/codex-relay:review --background
/codex-relay:status
/codex-relay:result
```

## Usage

### Relay routing and prompting policy

Automatic GPT-5.6 routing applies only to fresh `/codex-relay:rescue` tasks:

| Task class | Model | Effort |
| --- | --- | --- |
| Small, bounded, mechanical | `gpt-5.6-luna` | `low` |
| Normal, bounded diagnosis or implementation | `gpt-5.6-terra` | `medium` |
| Broad, ambiguous, cross-component, or high-value | `gpt-5.6-sol` | `high` |
| Architectural, high-risk, or unusually difficult | `gpt-5.6-sol` | `xhigh` |

Explicit choices take precedence. An explicit model and effort are both preserved; an explicit
model fills only the missing effort; and an explicit effort fills only the missing model. The
relay never selects `max` automatically: `max` is explicit-only.

Resumed work, including `--resume-id <thread-id>`, skips automatic routing. It preserves the
thread's model and effort defaults, forwards only explicit overrides, and keeps an explicitly
supplied thread ID exact.

For fresh implementation work, the relay uses a model-neutral prompt envelope. The user's task
text is preserved exactly inside `<task>`. Optional scope, success, evidence, and response blocks
are added only from concrete information already available; the relay does not rewrite the task,
invent requirements, or add model-specific prompting. Resumes send only the new delta, while
review commands keep their native review contracts.

### `/codex-relay:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/codex-relay:adversarial-review`](#codex-relayadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/codex-relay:review
/codex-relay:review --base main
/codex-relay:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/codex-relay:status`](#codex-relaystatus) to check on the progress and [`/codex-relay:cancel`](#codex-relaycancel) to cancel the ongoing task.

### `/codex-relay:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/codex-relay:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/codex-relay:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/codex-relay:adversarial-review
/codex-relay:adversarial-review --base main challenge whether this was the right caching and retry design
/codex-relay:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/codex-relay:rescue`

Hands a task to Codex through the `codex-relay:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, `--resume-id <thread-id>`, and `--fresh`. If you omit all resume and fresh routing flags, the plugin can offer to continue the latest rescue thread for this repo. `--resume-id` is mutually exclusive with `--resume`/latest-resume and `--fresh`.

Examples:

```bash
/codex-relay:rescue investigate why the tests started failing
/codex-relay:rescue fix the failing test with the smallest safe patch
/codex-relay:rescue --resume apply the top fix from the last run
/codex-relay:rescue --resume-id thr_exact continue this specific thread
/codex-relay:rescue --model gpt-5.4-mini --effort medium investigate the flaky integration test
/codex-relay:rescue --model spark fix the issue quickly
/codex-relay:rescue --background investigate the regression
/codex-relay:rescue --background --resume-id thr_exact continue this specific thread
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- fresh requests fill missing model and effort values using the relay policy above
- For resumed requests, omitted model or effort values preserve the existing thread's defaults; only explicit overrides are forwarded.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
- follow-up rescue requests can continue the latest Codex task in the repo
- `--resume-id <thread-id>` sends only the new prompt delta to exactly that Codex thread without consulting relay-tracked state; explicit model and effort overrides are preserved

### `/codex-relay:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.

Examples:

```bash
/codex-relay:transfer
/codex-relay:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer uses Codex's external-agent session importer, so it follows the same conversion rules as importing Claude history in the Codex App and creates visible turns that can be continued in the App or TUI. The source must be under `~/.claude/projects`, and older Codex versions that do not expose session import must be upgraded before using this command.

### `/codex-relay:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/codex-relay:status
/codex-relay:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/codex-relay:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/codex-relay:result
/codex-relay:result task-abc123
```

### `/codex-relay:cancel`

Cancels an active background Codex job.

Examples:

```bash
/codex-relay:cancel
/codex-relay:cancel task-abc123
```

### `/codex-relay:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

You can also use `/codex-relay:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/codex-relay:setup --enable-review-gate
/codex-relay:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/codex-relay:review
```

### Hand A Problem To Codex

```bash
/codex-relay:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/codex-relay:adversarial-review --background
/codex-relay:rescue --background investigate the flaky test
```

Then check in with:

```bash
/codex-relay:status
/codex-relay:result
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-5.4-mini` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "high"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/codex-relay:result` or `/codex-relay:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/codex-relay:setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).
