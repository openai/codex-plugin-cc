import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../plugins/codex/scripts/lib/args.mjs";

const TASK_CONFIG = {
  valueOptions: ["model", "effort", "cwd", "prompt-file"],
  booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
  aliasMap: {
    m: "model",
    C: "cwd"
  }
};

test("parseArgs with stopAtFirstPositional keeps prompt fragments out of options", () => {
  const result = parseArgs(["--write", "review", "-m", "pytest"], {
    ...TASK_CONFIG,
    stopAtFirstPositional: true
  });

  assert.equal(result.options.write, true);
  assert.equal(result.options.model, undefined);
  assert.equal(result.positionals.join(" "), "review -m pytest");
});

test("parseArgs without stopAtFirstPositional still consumes -m as model", () => {
  const result = parseArgs(["--write", "review", "-m", "pytest"], TASK_CONFIG);

  assert.equal(result.options.write, true);
  assert.equal(result.options.model, "pytest");
  assert.equal(result.positionals.join(" "), "review");
});

test("parseArgs honors -- passthrough before stopAtFirstPositional matters", () => {
  const result = parseArgs(["--write", "--", "-m", "pytest"], {
    ...TASK_CONFIG,
    stopAtFirstPositional: true
  });

  assert.equal(result.options.write, true);
  assert.equal(result.options.model, undefined);
  assert.equal(result.positionals.join(" "), "-m pytest");
});

test("stopAtFirstPositional stops after unrecognized long option becomes positional", () => {
  const result = parseArgs(["--write", "--coverage", "run", "-m", "pytest"], {
    ...TASK_CONFIG,
    stopAtFirstPositional: true
  });

  assert.equal(result.options.write, true);
  assert.equal(result.options.model, undefined);
  assert.equal(result.positionals.join(" "), "--coverage run -m pytest");
});

test("without stopAtFirstPositional unrecognized long then -m still sets model", () => {
  const result = parseArgs(["--write", "--coverage", "run", "-m", "pytest"], TASK_CONFIG);

  assert.equal(result.options.write, true);
  assert.equal(result.options.model, "pytest");
  assert.equal(result.positionals.join(" "), "--coverage run");
});

test("stopAtFirstPositional stops after unrecognized short option becomes positional", () => {
  const result = parseArgs(["--write", "-z", "-m", "pytest"], {
    ...TASK_CONFIG,
    stopAtFirstPositional: true
  });

  assert.equal(result.options.write, true);
  assert.equal(result.options.model, undefined);
  assert.equal(result.positionals.join(" "), "-z -m pytest");
});

test("stopAtFirstPositional still parses recognized flags before first positional", () => {
  const result = parseArgs(["--write", "--model", "spark", "fix it"], {
    ...TASK_CONFIG,
    stopAtFirstPositional: true
  });

  assert.equal(result.options.write, true);
  assert.equal(result.options.model, "spark");
  assert.equal(result.positionals.join(" "), "fix it");
});
