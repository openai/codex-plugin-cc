---
name: codex-prompting
description: Shape implementation prompts before delegating work to Codex.
user-invocable: false
---

# Codex Prompting

Use this skill in the main Claude context before invoking the Codex relay agent.

For a fresh implementation task, preserve the user's original task text exactly:

<task>
[the user's exact task text]
</task>

Add these blocks only when they contain concrete information already known from the conversation or repository:

<scope_and_success>
[in-scope files, constraints, acceptance criteria, and non-goals]
</scope_and_success>

<evidence_and_final_response>
[required tests, verification evidence, and requested response shape]
</evidence_and_final_response>

Do not paraphrase, shorten, or “improve” the text inside <task>. Do not invent requirements. Do not add generic instructions such as “be concise” or “think harder,” and do not request hidden chain-of-thought.

For a resume, send only the user's new delta or correction. Do not repeat the original task or previously supplied context.

For review and adversarial-review work, retain the review command's native finding-first contract instead of wrapping it in the implementation-task structure above.
