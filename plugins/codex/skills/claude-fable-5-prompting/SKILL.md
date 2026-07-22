---
name: claude-fable-5-prompting
description: Internal guidance for composing prompts and collaboration messages addressed to Claude Fable 5 (Claude 5 family)
user-invocable: false
---

# Claude Fable 5 Prompting

Use this when composing a prompt, review request, rebuttal, or protocol message whose reader is Claude Fable 5 — the counterpart to `gpt-5-6-prompting`. Based on Anthropic's official "Prompting Claude Fable 5" guidance.

Core rules:

- Brief, high-trust instructions beat enumerated lists. One short scope or brevity instruction reliably curbs unwanted behavior; prescriptive micromanagement written for older models degrades Fable 5 output.
- Effort: `high` is the right default; reserve `xhigh` for the most capability-sensitive work. Over-provisioning effort causes overplanning and unrequested tidying, not better answers.
- State authorization boundaries explicitly. Distinguish "assess and report" from "do the fix"; add "don't do X unless asked" for actions you don't want volunteered — Fable 5 will otherwise take reasonable-but-unrequested actions.
- Give reasons, not just requests. One line of intent framing ("this feeds X, which needs Y") measurably improves how it connects the task to relevant context.
- Require grounded progress claims: "audit each claim against a tool result from this session before reporting it" — this nearly eliminates fabricated status reports on long runs.
- For ambiguous tasks add "when you have enough information to act, act" — stops overplanning.
- Prefer async patterns: long-lived context, message-and-continue, check on results later. Do not design blocking waits into prompts.
- Never ask it to transcribe or echo its reasoning into the response — that can trigger the `reasoning_extraction` refusal classifier. Ask for conclusions and evidence instead.
- Ask for outcome-first final answers in complete sentences; permit terse shorthand only mid-work, never in the final summary.
