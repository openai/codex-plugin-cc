import test from "node:test";
import assert from "node:assert/strict";

import { parseReviewArgv, parseTaskArgv } from "../plugins/codex/scripts/lib/args.mjs";

// Regression coverage for issue #699 (defect 1): free-form prompt text was parsed
// as CLI options. A task prompt containing `python -m pytest` was tokenized and the
// undocumented `-m` alias consumed the next word as `--model` (e.g. `--model pytest`,
// which the gateway rejects with a 404), while also dropping those words from the
// prompt. Only the documented long `--model` form should select a model.

test("task prompt keeps `-m` tokens instead of hijacking --model", () => {
  const { options, positionals } = parseTaskArgv([
    "fix the failing python -m pytest tests suite"
  ]);

  assert.equal(options.model, undefined, "no model should be inferred from prompt text");
  assert.equal(
    positionals.join(" "),
    "fix the failing python -m pytest tests suite",
    "the prompt text must be preserved verbatim, including `-m pytest`"
  );
});

test("bare `-m value` in a task prompt no longer sets the model", () => {
  const { options, positionals } = parseTaskArgv(["-m pytest"]);

  assert.equal(options.model, undefined);
  assert.deepEqual(positionals, ["-m", "pytest"]);
});

test("task still honors the documented long --model flag", () => {
  const { options, positionals } = parseTaskArgv(["--model spark do the thing"]);

  assert.equal(options.model, "spark");
  assert.equal(positionals.join(" "), "do the thing");
});

test("task boolean flags still parse alongside a prompt", () => {
  const { options, positionals } = parseTaskArgv([
    "--background --write refactor the payment module"
  ]);

  assert.equal(options.background, true);
  assert.equal(options.write, true);
  assert.equal(positionals.join(" "), "refactor the payment module");
});

test("review focus text keeps `-m` tokens but still honors --model", () => {
  const swallowed = parseReviewArgv(["check the -m pytest invocation in ci"]);
  assert.equal(swallowed.options.model, undefined);
  assert.equal(swallowed.positionals.join(" "), "check the -m pytest invocation in ci");

  const explicit = parseReviewArgv(["--model spark --scope branch"]);
  assert.equal(explicit.options.model, "spark");
  assert.equal(explicit.options.scope, "branch");
});
