import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildClaudeContextBrief,
  composeTaskPromptWithBrief,
  CONTEXT_MODES,
  normalizeContextMode
} from "../plugins/codex/scripts/lib/claude-context-brief.mjs";
import { parseArgs } from "../plugins/codex/scripts/lib/args.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

// Mirrors the option shape handleTask passes to parseCommandInput.
const TASK_ARG_CONFIG = {
  valueOptions: ["model", "effort", "cwd", "prompt-file", "session-context-mode", "session-turns", "session-max-chars", "source"],
  booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "session-context"],
  aliasMap: { m: "model" }
};

const HOME_KEYS = ["HOME", "USERPROFILE"];

function withFakeHome(callback) {
  const home = makeTempDir("codex-plugin-home-");
  const previous = HOME_KEYS.map((key) => [key, process.env[key]]);
  for (const key of HOME_KEYS) {
    process.env[key] = home;
  }
  try {
    return callback(home);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function writeTranscript(home, sessionId, entries) {
  const projectDir = path.join(home, ".claude", "projects", "-tmp-project");
  fs.mkdirSync(projectDir, { recursive: true });
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return transcriptPath;
}

function userTurn(text) {
  return { type: "user", message: { role: "user", content: text } };
}

function assistantTurn(text) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function compactSummary(text, timestamp = "2026-01-01T00:00:00.000Z") {
  return {
    type: "user",
    isCompactSummary: true,
    timestamp,
    message: { role: "user", content: text }
  };
}

test("normalizeContextMode maps absence and shorthand", () => {
  assert.equal(normalizeContextMode(undefined), "none");
  assert.equal(normalizeContextMode(""), "none");
  assert.equal(normalizeContextMode(true), "auto");
  assert.equal(normalizeContextMode("Summary"), "summary");
  for (const mode of CONTEXT_MODES) {
    assert.equal(normalizeContextMode(mode), mode);
  }
  assert.throws(() => normalizeContextMode("everything"), /Unsupported context mode/);
});

test("buildClaudeContextBrief returns null when context is off", () => {
  assert.equal(buildClaudeContextBrief(process.cwd(), { mode: "none" }), null);
  assert.equal(buildClaudeContextBrief(process.cwd(), {}), null);
});

test("auto mode keeps the compact summary and only the turns after it", () => {
  withFakeHome((home) => {
    const transcriptPath = writeTranscript(home, "session-auto", [
      userTurn("pre-compact question"),
      assistantTurn("pre-compact answer"),
      { type: "system", subtype: "compact_boundary", isMeta: true },
      compactSummary("1. Primary Request and Intent: fix the failing login test."),
      userTurn("after compact question"),
      assistantTurn("after compact answer")
    ]);

    const brief = buildClaudeContextBrief(makeTempDir(), { mode: "auto", source: transcriptPath });

    assert.equal(brief.stats.hasSummary, true);
    assert.equal(brief.stats.includedTurnCount, 2);
    assert.match(brief.text, /fix the failing login test/);
    assert.match(brief.text, /after compact question/);
    assert.doesNotMatch(brief.text, /pre-compact question/);
    assert.match(brief.text, /Conversation after that summary/);
  });
});

test("summary mode omits conversation turns and recent mode omits the summary", () => {
  withFakeHome((home) => {
    const transcriptPath = writeTranscript(home, "session-modes", [
      userTurn("older question"),
      compactSummary("summary body text"),
      userTurn("newer question")
    ]);
    const cwd = makeTempDir();

    const summaryOnly = buildClaudeContextBrief(cwd, { mode: "summary", source: transcriptPath });
    assert.equal(summaryOnly.stats.includedTurnCount, 0);
    assert.match(summaryOnly.text, /summary body text/);
    assert.doesNotMatch(summaryOnly.text, /newer question/);

    const recentOnly = buildClaudeContextBrief(cwd, { mode: "recent", source: transcriptPath });
    assert.equal(recentOnly.stats.hasSummary, false);
    assert.doesNotMatch(recentOnly.text, /summary body text/);
    assert.match(recentOnly.text, /older question/);
    assert.match(recentOnly.text, /newer question/);
  });
});

test("sidechain, meta, and tool-only entries are excluded", () => {
  withFakeHome((home) => {
    const transcriptPath = writeTranscript(home, "session-noise", [
      userTurn("real question"),
      { type: "user", isSidechain: true, message: { role: "user", content: "subagent chatter" } },
      { type: "assistant", isMeta: true, message: { role: "assistant", content: [{ type: "text", text: "meta note" }] } },
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "tool output blob" }] }
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private reasoning" },
            { type: "tool_use", name: "Read", input: {} },
            { type: "text", text: "real answer" }
          ]
        }
      },
      { type: "file-history-snapshot", payload: {} }
    ]);

    const brief = buildClaudeContextBrief(makeTempDir(), { mode: "recent", source: transcriptPath });

    assert.equal(brief.stats.includedTurnCount, 2);
    assert.match(brief.text, /real question/);
    assert.match(brief.text, /real answer/);
    for (const noise of ["subagent chatter", "meta note", "tool output blob", "private reasoning"]) {
      assert.doesNotMatch(brief.text, new RegExp(noise));
    }
  });
});

test("system-reminder blocks are stripped from turn text", () => {
  withFakeHome((home) => {
    const transcriptPath = writeTranscript(home, "session-reminder", [
      userTurn("keep this <system-reminder>drop this injected note</system-reminder>")
    ]);

    const brief = buildClaudeContextBrief(makeTempDir(), { mode: "recent", source: transcriptPath });

    assert.match(brief.text, /keep this/);
    assert.doesNotMatch(brief.text, /drop this injected note/);
  });
});

test("oversized transcripts drop the oldest turns and report truncation", () => {
  withFakeHome((home) => {
    const filler = "x".repeat(4000);
    const transcriptPath = writeTranscript(home, "session-large", [
      userTurn(`oldest ${filler}`),
      userTurn(`middle ${filler}`),
      userTurn(`newest ${filler}`)
    ]);

    const brief = buildClaudeContextBrief(makeTempDir(), {
      mode: "recent",
      source: transcriptPath,
      maxChars: 9000
    });

    assert.equal(brief.stats.truncated, true);
    assert.ok(brief.stats.droppedTurnCount >= 1);
    assert.match(brief.text, /newest/);
    assert.doesNotMatch(brief.text, /oldest/);
    assert.match(brief.text, /earlier turn\(s\) omitted for length/);
  });
});

test("context-turns caps how many recent turns are attached", () => {
  withFakeHome((home) => {
    const entries = [];
    for (let index = 0; index < 10; index += 1) {
      entries.push(userTurn(`turn number ${index}`));
    }
    const transcriptPath = writeTranscript(home, "session-limit", entries);

    const brief = buildClaudeContextBrief(makeTempDir(), {
      mode: "recent",
      source: transcriptPath,
      recentTurns: 3
    });

    assert.equal(brief.stats.includedTurnCount, 3);
    assert.match(brief.text, /turn number 9/);
    assert.doesNotMatch(brief.text, /turn number 6/);
  });
});

test("full mode ignores the recent-turn cap and the summary", () => {
  withFakeHome((home) => {
    const transcriptPath = writeTranscript(home, "session-full", [
      userTurn("first"),
      compactSummary("summary body"),
      userTurn("second"),
      userTurn("third")
    ]);

    const brief = buildClaudeContextBrief(makeTempDir(), {
      mode: "full",
      source: transcriptPath,
      recentTurns: 1
    });

    assert.equal(brief.stats.hasSummary, false);
    assert.equal(brief.stats.includedTurnCount, 3);
    assert.match(brief.text, /first/);
    assert.match(brief.text, /third/);
  });
});

test("repository state is attached when the cwd is a git repo", () => {
  withFakeHome((home) => {
    const transcriptPath = writeTranscript(home, "session-repo", [userTurn("look at my branch")]);
    const cwd = makeTempDir();
    initGitRepo(cwd);
    fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
    run("git", ["add", "app.js"], { cwd });
    run("git", ["commit", "-m", "init"], { cwd });
    run("git", ["checkout", "-b", "feature/handoff"], { cwd });
    fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

    const brief = buildClaudeContextBrief(cwd, { mode: "recent", source: transcriptPath });

    assert.equal(brief.stats.branch, "feature/handoff");
    assert.match(brief.text, /Repository state at handoff/);
    assert.match(brief.text, /feature\/handoff/);
    assert.match(brief.text, /app\.js/);
  });
});

test("a non-git directory still produces a brief without repository state", () => {
  withFakeHome((home) => {
    const transcriptPath = writeTranscript(home, "session-nogit", [userTurn("no repo here")]);

    const brief = buildClaudeContextBrief(makeTempDir(), { mode: "recent", source: transcriptPath });

    assert.equal(brief.stats.branch, null);
    assert.doesNotMatch(brief.text, /Repository state at handoff/);
  });
});

test("a stale compact summary is flagged", () => {
  withFakeHome((home) => {
    const transcriptPath = writeTranscript(home, "session-stale", [
      compactSummary("old summary", "2026-01-01T00:00:00.000Z"),
      userTurn("still going")
    ]);

    const stale = buildClaudeContextBrief(makeTempDir(), {
      mode: "auto",
      source: transcriptPath,
      now: Date.parse("2026-01-01T05:00:00.000Z")
    });
    assert.equal(stale.stats.staleSummary, true);

    const fresh = buildClaudeContextBrief(makeTempDir(), {
      mode: "auto",
      source: transcriptPath,
      now: Date.parse("2026-01-01T00:05:00.000Z")
    });
    assert.equal(fresh.stats.staleSummary, false);
  });
});

test("a transcript with no usable conversation is rejected", () => {
  withFakeHome((home) => {
    const transcriptPath = writeTranscript(home, "session-empty", [
      { type: "file-history-snapshot", payload: {} },
      { type: "queue-operation", payload: {} }
    ]);

    assert.throws(
      () => buildClaudeContextBrief(makeTempDir(), { mode: "auto", source: transcriptPath }),
      /No usable conversation found/
    );
  });
});

test("a truncated trailing line does not break parsing", () => {
  withFakeHome((home) => {
    const transcriptPath = writeTranscript(home, "session-partial", [userTurn("complete turn")]);
    fs.appendFileSync(transcriptPath, '{"type":"assistant","message":{"role":"assist');

    const brief = buildClaudeContextBrief(makeTempDir(), { mode: "recent", source: transcriptPath });

    assert.equal(brief.stats.includedTurnCount, 1);
  });
});

test("transcripts outside the Claude projects directory are refused", () => {
  withFakeHome((home) => {
    writeTranscript(home, "session-inside", [userTurn("inside")]);
    const outside = path.join(makeTempDir(), "elsewhere.jsonl");
    fs.writeFileSync(outside, `${JSON.stringify(userTurn("hi"))}\n`);

    assert.throws(
      () => buildClaudeContextBrief(makeTempDir(), { mode: "auto", source: outside }),
      /only from/
    );
  });
});

test("--session-context is boolean and never swallows the task text", () => {
  const { options, positionals } = parseArgs(
    ["--session-context", "fix", "the", "failing", "login", "test"],
    TASK_ARG_CONFIG
  );

  assert.equal(options["session-context"], true);
  assert.equal(options["session-context-mode"], undefined);
  assert.deepEqual(positionals, ["fix", "the", "failing", "login", "test"]);
  assert.equal(normalizeContextMode(options["session-context-mode"] ?? (options["session-context"] ? "auto" : undefined)), "auto");
});

test("--session-context-mode takes a value and implies the flag", () => {
  const { options, positionals } = parseArgs(
    ["--session-context-mode", "full", "investigate", "the", "regression"],
    TASK_ARG_CONFIG
  );

  assert.equal(options["session-context-mode"], "full");
  assert.deepEqual(positionals, ["investigate", "the", "regression"]);
  assert.equal(normalizeContextMode(options["session-context-mode"] ?? (options["session-context"] ? "auto" : undefined)), "full");
});

test("omitting both context flags leaves context off", () => {
  const { options, positionals } = parseArgs(["fix", "the", "bug"], TASK_ARG_CONFIG);

  assert.equal(normalizeContextMode(options["session-context-mode"] ?? (options["session-context"] ? "auto" : undefined)), "none");
  assert.deepEqual(positionals, ["fix", "the", "bug"]);
});

test("composeTaskPromptWithBrief frames the brief and appends the request", () => {
  const brief = { text: "BRIEF BODY", stats: {} };

  const withRequest = composeTaskPromptWithBrief(brief, "fix the login");
  assert.match(withRequest, /BRIEF BODY/);
  assert.match(withRequest, /## Task/);
  assert.match(withRequest, /fix the login/);

  const withoutRequest = composeTaskPromptWithBrief(brief, "   ");
  assert.match(withoutRequest, /Continue the work described in the handoff brief/);

  assert.equal(composeTaskPromptWithBrief(null, "just this"), "just this");
});
