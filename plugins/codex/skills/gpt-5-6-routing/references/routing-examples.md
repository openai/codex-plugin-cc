# Routing Examples

These examples apply only to fresh rescue work unless labeled as a resume.
Filled values become flags; unset values remain omitted. Prompt text is always
unchanged.

## 1. Small

Task: Correct a known typo in one configuration file and run its focused test.

- Classification: small and bounded.
- Missing values filled: model `gpt-5.6-luna`; effort `low`.
- Values left unset: none.

## 2. Normal

Task: Diagnose and fix a bounded validation bug across three known files, then
run the standard test suite.

- Classification: normal and bounded.
- Missing values filled: model `gpt-5.6-terra`; effort `medium`.
- Values left unset: none.

## 3. Broad

Task: Trace a state-management issue across the API, UI, and persistence layer
with meaningful repository exploration and substantial regression testing.

- Classification: broad, ambiguous, or high-value.
- Missing values filled: model `gpt-5.6-sol`; effort `high`.
- Values left unset: none.

## 4. Architectural

Task: Choose and implement a cross-cutting authentication architecture with
hard-to-reverse compatibility and migration consequences.

- Classification: architectural, high-risk, or unusually difficult.
- Missing values filled: model `gpt-5.6-sol`; effort `xhigh`.
- Values left unset: none.

## 5. Model-only partial override

Task: The normal bounded validation task above, with model `custom-model`
explicitly supplied by the user.

- Classification: normal and bounded, for the missing effort only.
- Missing values filled: effort `medium`.
- Values left unset: none; model `custom-model` is preserved, not filled.

## 6. Effort-only partial override

Task: The broad cross-component task above, with effort `low` explicitly
supplied by the user.

- Classification: broad, ambiguous, or high-value, for the missing model only.
- Missing values filled: model `gpt-5.6-sol`.
- Values left unset: none; effort `low` is preserved, not filled.

## 7. Resume

Task: Continue an existing thread with no new model or effort flags.

- Classification: none; resume work is never classified.
- Missing values filled: none.
- Values left unset: model and effort, preserving the thread's original
  defaults. Any explicit resume override would be forwarded unchanged.

## 8. Ambiguous boundary

Task: A fresh change spans several coordinated files and may require either
standard or substantial verification; the facts support the normal and broad
classes equally.

- Classification: broad, ambiguous, or high-value, the higher adjacent class.
- Missing values filled: model `gpt-5.6-sol`; effort `high`.
- Values left unset: none.

## 9. Insufficient context

Task: "Fix it," with no repository, symptom, scope, or expected outcome.

- Classification: none; available information supports no class.
- Missing values filled: none.
- Values left unset: model and effort, so upstream runtime defaults apply.
