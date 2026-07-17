import test from "node:test";
import assert from "node:assert/strict";

import {
  branchNameForBrief,
  FANOUT_MAX_CONCURRENCY,
  parseFanoutBriefs,
  runFanout
} from "../plugins/codex/scripts/lib/fanout.mjs";

function makeBriefsJson(count) {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      id: `brief-${index}`,
      prompt: `Do task ${index}.`
    }))
  );
}

function makeMockContext({ runTurn, cleanup = false } = {}) {
  const createdWorktrees = [];
  const removedWorktrees = [];

  return {
    cleanup,
    createWorktree: async (repoRoot, worktreeRoot, brief) => {
      const worktree = { path: `${worktreeRoot}/${brief.id}`, branch: branchNameForBrief(brief) };
      createdWorktrees.push(worktree);
      return worktree;
    },
    removeWorktree: async (repoRoot, worktreePath, branch) => {
      removedWorktrees.push({ worktreePath, branch });
    },
    runTurn,
    createdWorktrees,
    removedWorktrees
  };
}

test("parseFanoutBriefs validates and defaults a briefs array", () => {
  const briefs = parseFanoutBriefs(makeBriefsJson(2));
  assert.equal(briefs.length, 2);
  assert.equal(briefs[0].id, "brief-0");
  assert.equal(briefs[0].verb, "implement");
  assert.equal(briefs[0].write, true);
});

test("parseFanoutBriefs rejects invalid JSON, non-arrays, missing fields, and duplicate ids", () => {
  assert.throws(() => parseFanoutBriefs("not json"), /not valid JSON/);
  assert.throws(() => parseFanoutBriefs("{}"), /non-empty JSON array/);
  assert.throws(() => parseFanoutBriefs("[]"), /non-empty JSON array/);
  assert.throws(() => parseFanoutBriefs(JSON.stringify([{ prompt: "x" }])), /missing a non-empty string "id"/);
  assert.throws(() => parseFanoutBriefs(JSON.stringify([{ id: "a" }])), /missing a non-empty string "prompt"/);
  assert.throws(
    () => parseFanoutBriefs(JSON.stringify([{ id: "a", prompt: "x" }, { id: "a", prompt: "y" }])),
    /Duplicate brief id "a"/
  );
});

test("runFanout caps concurrency at FANOUT_MAX_CONCURRENCY and queues the rest", async () => {
  const briefs = parseFanoutBriefs(makeBriefsJson(8));
  let inFlight = 0;
  let maxInFlight = 0;

  const context = makeMockContext({
    runTurn: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return {
        status: 0,
        finalMessage: "",
        envelope: { status: "DONE", summary: "ok", files_modified: [], concerns: [], blocked_reason: null }
      };
    }
  });

  const aggregate = await runFanout("/repo", "/worktrees", briefs, {
    concurrency: 100,
    createWorktree: context.createWorktree,
    removeWorktree: context.removeWorktree,
    runTurn: context.runTurn
  });

  assert.ok(maxInFlight <= FANOUT_MAX_CONCURRENCY, `expected max in-flight <= ${FANOUT_MAX_CONCURRENCY}, got ${maxInFlight}`);
  assert.equal(aggregate.results.length, 8);
});

test("runFanout honors a lower explicit concurrency than the cap", async () => {
  const briefs = parseFanoutBriefs(makeBriefsJson(6));
  let inFlight = 0;
  let maxInFlight = 0;

  const context = makeMockContext({
    runTurn: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return {
        status: 0,
        finalMessage: "",
        envelope: { status: "DONE", summary: "ok", files_modified: [], concerns: [], blocked_reason: null }
      };
    }
  });

  await runFanout("/repo", "/worktrees", briefs, {
    concurrency: 2,
    createWorktree: context.createWorktree,
    removeWorktree: context.removeWorktree,
    runTurn: context.runTurn
  });

  assert.equal(maxInFlight, 2);
});

test("runFanout aggregates successes, failures, and quota-exhausted outcomes into separate buckets", async () => {
  const briefs = parseFanoutBriefs(
    JSON.stringify([
      { id: "ok-1", prompt: "succeed" },
      { id: "boom", prompt: "explode" },
      { id: "quota", prompt: "hit quota" }
    ])
  );

  const context = makeMockContext({
    runTurn: async (cwd, options) => {
      if (options.prompt === "explode") {
        throw new Error("unrelated worker failure");
      }
      if (options.prompt === "hit quota") {
        return {
          status: "BLOCKED",
          blocked_reason: "QUOTA_EXHAUSTED",
          summary: "Quota exhausted at tier sol and step-down tier terra.",
          files_modified: [],
          concerns: [],
          envelope: undefined
        };
      }
      return {
        status: 0,
        finalMessage: "",
        envelope: { status: "DONE", summary: "done", files_modified: [], concerns: [], blocked_reason: null }
      };
    }
  });

  const aggregate = await runFanout("/repo", "/worktrees", briefs, {
    createWorktree: context.createWorktree,
    removeWorktree: context.removeWorktree,
    runTurn: context.runTurn
  });

  assert.equal(aggregate.results.length, 1);
  assert.equal(aggregate.results[0].id, "ok-1");
  assert.equal(aggregate.results[0].envelope.status, "DONE");

  assert.equal(aggregate.failed.length, 1);
  assert.equal(aggregate.failed[0].id, "boom");
  assert.match(aggregate.failed[0].error, /unrelated worker failure/);

  assert.equal(aggregate.quota_exhausted.length, 1);
  assert.equal(aggregate.quota_exhausted[0].id, "quota");
  assert.equal(aggregate.quota_exhausted[0].envelope.blocked_reason, "QUOTA_EXHAUSTED");
});

test("runFanout only removes worktrees when cleanup is requested", async () => {
  const briefs = parseFanoutBriefs(makeBriefsJson(2));
  const runTurn = async () => ({
    status: 0,
    finalMessage: "",
    envelope: { status: "DONE", summary: "ok", files_modified: [], concerns: [], blocked_reason: null }
  });

  const noCleanupContext = makeMockContext({ runTurn, cleanup: false });
  await runFanout("/repo", "/worktrees", briefs, {
    createWorktree: noCleanupContext.createWorktree,
    removeWorktree: noCleanupContext.removeWorktree,
    runTurn: noCleanupContext.runTurn
  });
  assert.equal(noCleanupContext.removedWorktrees.length, 0);

  const cleanupContext = makeMockContext({ runTurn, cleanup: true });
  await runFanout("/repo", "/worktrees", briefs, {
    cleanup: true,
    createWorktree: cleanupContext.createWorktree,
    removeWorktree: cleanupContext.removeWorktree,
    runTurn: cleanupContext.runTurn
  });
  assert.equal(cleanupContext.removedWorktrees.length, 2);
});

test("a cleanup failure annotates the entry with cleanupWarning instead of discarding the real result", async () => {
  const briefs = parseFanoutBriefs(makeBriefsJson(1));
  const context = makeMockContext({
    cleanup: true,
    runTurn: async () => ({
      status: 0,
      finalMessage: "",
      envelope: { status: "DONE", summary: "worker succeeded", files_modified: [], concerns: [], blocked_reason: null }
    })
  });
  context.removeWorktree = async () => {
    throw new Error("failed to delete worktree: Permission denied");
  };

  const aggregate = await runFanout("/repo", "/worktrees", briefs, {
    cleanup: true,
    createWorktree: context.createWorktree,
    removeWorktree: context.removeWorktree,
    runTurn: context.runTurn
  });

  assert.equal(aggregate.failed.length, 0, "a cleanup failure must not be misreported as a worker failure");
  assert.equal(aggregate.results.length, 1);
  assert.equal(aggregate.results[0].envelope.status, "DONE");
  assert.match(aggregate.results[0].cleanupWarning, /Permission denied/);
});

test("a worktree-creation failure becomes a failed entry without discarding the other workers", async () => {
  const briefs = parseFanoutBriefs(
    JSON.stringify([
      { id: "ok", prompt: "Do the good task." },
      { id: "collision", prompt: "This worker's worktree cannot be created." }
    ])
  );
  const context = makeMockContext({
    runTurn: async () => ({
      status: 0,
      finalMessage: "",
      envelope: { status: "DONE", summary: "worker succeeded", files_modified: [], concerns: [], blocked_reason: null }
    })
  });
  context.createWorktree = async (repoRoot, worktreeRoot, brief) => {
    if (brief.id === "collision") {
      throw new Error("fatal: a branch named 'fanout/collision' already exists");
    }
    return { path: `${worktreeRoot}/${brief.id}`, branch: branchNameForBrief(brief) };
  };

  const aggregate = await runFanout("/repo", "/worktrees", briefs, {
    createWorktree: context.createWorktree,
    removeWorktree: context.removeWorktree,
    runTurn: context.runTurn
  });

  assert.equal(aggregate.results.length, 1, "the healthy worker's result must survive");
  assert.equal(aggregate.results[0].id, "ok");
  assert.equal(aggregate.failed.length, 1);
  assert.equal(aggregate.failed[0].id, "collision");
  assert.equal(aggregate.failed[0].workspace, null);
  assert.equal(aggregate.failed[0].branch, "fanout/collision");
  assert.match(aggregate.failed[0].error, /already exists/);
});

test("runFanout rejects an empty brief list", async () => {
  await assert.rejects(runFanout("/repo", "/worktrees", []), /non-empty array of brief specs/);
});
