/**
 * Rig-edition fanout verb: N brief specs -> one git worktree per worker ->
 * concurrent tiered Codex turns -> aggregated typed envelopes.
 *
 * Additive layer over rig-edition.mjs and process.mjs. Concurrency is capped
 * at FANOUT_MAX_CONCURRENCY regardless of the caller's request; briefs beyond
 * the cap queue behind it. Worktrees are created for every worker and are
 * only removed when the caller opts into cleanup -- leaving a worktree
 * behind is the safe default so a caller can inspect a worker's output.
 *
 * @typedef {{
 *   id: string,
 *   prompt: string,
 *   verb: string,
 *   tier: string | undefined,
 *   effort: string | undefined,
 *   branch: string | undefined,
 *   write: boolean
 * }} FanoutBriefSpec
 * @typedef {{ path: string, branch: string }} Worktree
 */
import fs from "node:fs";
import path from "node:path";

import { QUOTA_EXHAUSTED_REASON, runTieredTurn } from "./rig-edition.mjs";
import { runCommandChecked } from "./process.mjs";

export const FANOUT_MAX_CONCURRENCY = 5;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Parses and validates a fanout briefs JSON document (an array of brief
 * specs). Never returns a partially-valid result -- throws with the first
 * validation error found.
 * @param {string} rawJsonText
 * @returns {Readonly<FanoutBriefSpec[]>}
 */
export function parseFanoutBriefs(rawJsonText) {
  let parsed;
  try {
    parsed = JSON.parse(rawJsonText);
  } catch (error) {
    throw new Error(`Fanout briefs file is not valid JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Fanout briefs file must contain a non-empty JSON array of brief specs.");
  }

  const seenIds = new Set();
  const briefs = parsed.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Brief at index ${index} must be an object.`);
    }
    if (!isNonEmptyString(raw.id)) {
      throw new Error(`Brief at index ${index} is missing a non-empty string "id".`);
    }
    if (seenIds.has(raw.id)) {
      throw new Error(`Duplicate brief id "${raw.id}".`);
    }
    seenIds.add(raw.id);
    if (!isNonEmptyString(raw.prompt)) {
      throw new Error(`Brief "${raw.id}" is missing a non-empty string "prompt".`);
    }

    return Object.freeze({
      id: raw.id,
      prompt: raw.prompt,
      verb: isNonEmptyString(raw.verb) ? raw.verb : "implement",
      tier: isNonEmptyString(raw.tier) ? raw.tier : undefined,
      effort: isNonEmptyString(raw.effort) ? raw.effort : undefined,
      branch: isNonEmptyString(raw.branch) ? raw.branch : undefined,
      write: raw.write !== false
    });
  });

  return Object.freeze(briefs);
}

/**
 * @param {string} filePath
 * @returns {Readonly<FanoutBriefSpec[]>}
 */
export function loadFanoutBriefsFromFile(filePath) {
  return parseFanoutBriefs(fs.readFileSync(filePath, "utf8"));
}

function git(cwd, args) {
  return runCommandChecked("git", args, { cwd, shell: false });
}

/**
 * @param {FanoutBriefSpec} brief
 */
export function branchNameForBrief(brief) {
  return brief.branch ?? `fanout/${brief.id}`;
}

/**
 * Creates a git worktree for one fanout worker, branching from HEAD of
 * repoRoot into a caller-given worktree root.
 * @param {string} repoRoot
 * @param {string} worktreeRoot
 * @param {FanoutBriefSpec} brief
 * @returns {Promise<Worktree>}
 */
export async function createWorktree(repoRoot, worktreeRoot, brief) {
  const branch = branchNameForBrief(brief);
  const worktreePath = path.join(worktreeRoot, brief.id);
  git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
  return Object.freeze({ path: worktreePath, branch });
}

/**
 * Removes a fanout worker's worktree and its branch. Branch deletion is
 * best-effort: a failure there does not undo a successful worktree removal.
 * @param {string} repoRoot
 * @param {string} worktreePath
 * @param {string} branch
 */
export async function removeWorktree(repoRoot, worktreePath, branch) {
  git(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  if (!branch) {
    return;
  }
  try {
    git(repoRoot, ["branch", "-D", branch]);
  } catch {
    // Worktree removal already succeeded; branch cleanup is best-effort.
  }
}

function resolveConcurrency(requested) {
  const parsed = Number(requested);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return FANOUT_MAX_CONCURRENCY;
  }
  return Math.min(Math.floor(parsed), FANOUT_MAX_CONCURRENCY);
}

/**
 * Runs `worker` over `items` with at most `limit` in flight at once. Extra
 * items queue behind the limit rather than launching immediately.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function runWithConcurrencyLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function pullNext() {
    const current = cursor;
    cursor += 1;
    if (current >= items.length) {
      return;
    }
    results[current] = await worker(items[current], current);
    await pullNext();
  }

  const lanes = Array.from({ length: Math.min(limit, items.length) }, () => pullNext());
  await Promise.all(lanes);
  return results;
}

async function computeWorkerOutcome(brief, worktree, context) {
  try {
    const outcome = await context.runTurn(worktree.path, {
      verb: brief.verb,
      tier: brief.tier,
      effort: brief.effort,
      prompt: brief.prompt,
      sandbox: brief.write ? "workspace-write" : "read-only"
    });

    if (outcome?.status === "BLOCKED" && outcome?.blocked_reason === QUOTA_EXHAUSTED_REASON) {
      return {
        bucket: "quota_exhausted",
        entry: {
          id: brief.id,
          workspace: worktree.path,
          branch: worktree.branch,
          envelope: outcome
        }
      };
    }

    return {
      bucket: "results",
      entry: {
        id: brief.id,
        workspace: worktree.path,
        branch: worktree.branch,
        envelope: outcome?.envelope ?? null,
        status: outcome?.status ?? null
      }
    };
  } catch (error) {
    return {
      bucket: "failed",
      entry: {
        id: brief.id,
        workspace: worktree.path,
        branch: worktree.branch,
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

// A cleanup failure (e.g. a Windows file-lock still held on the worktree by
// the Codex process at removal time) must never discard the worker's real
// outcome -- a throw in a `finally` block replaces whatever the `try` block
// returned, which would turn a genuine success into a spurious failure. So
// cleanup runs after the outcome is already computed, and a cleanup error
// only annotates the entry with `cleanupWarning`; the worktree is left in
// place for manual inspection/removal.
async function runFanoutWorker(brief, context) {
  let worktree;
  try {
    worktree = await context.createWorktree(context.repoRoot, context.worktreeRoot, brief);
  } catch (error) {
    // A worktree-setup failure (branch collision, path already exists, a lock
    // held by a prior run) must become this worker's `failed` entry, never a
    // rejected lane -- Promise.all over the concurrency lanes would otherwise
    // discard every other worker's result and the queued briefs behind them.
    return {
      bucket: "failed",
      entry: Object.freeze({
        id: brief.id,
        workspace: null,
        branch: branchNameForBrief(brief),
        error: error instanceof Error ? error.message : String(error)
      })
    };
  }
  const outcome = await computeWorkerOutcome(brief, worktree, context);

  if (!context.cleanup) {
    return { bucket: outcome.bucket, entry: Object.freeze(outcome.entry) };
  }

  try {
    await context.removeWorktree(context.repoRoot, worktree.path, worktree.branch);
    return { bucket: outcome.bucket, entry: Object.freeze(outcome.entry) };
  } catch (cleanupError) {
    return {
      bucket: outcome.bucket,
      entry: Object.freeze({
        ...outcome.entry,
        cleanupWarning: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      })
    };
  }
}

/**
 * Runs a fanout across brief specs: one worktree + one tiered Codex turn per
 * brief, at most FANOUT_MAX_CONCURRENCY concurrently, aggregated
 * orchestrator-side into results / failed / quota_exhausted buckets.
 * @param {string} repoRoot
 * @param {string} worktreeRoot
 * @param {FanoutBriefSpec[]} briefs
 * @param {{
 *   concurrency?: number,
 *   cleanup?: boolean,
 *   createWorktree?: typeof createWorktree,
 *   removeWorktree?: typeof removeWorktree,
 *   runTurn?: typeof runTieredTurn
 * }} [options]
 */
export async function runFanout(repoRoot, worktreeRoot, briefs, options = {}) {
  if (!Array.isArray(briefs) || briefs.length === 0) {
    throw new Error("runFanout requires a non-empty array of brief specs.");
  }

  const context = {
    repoRoot,
    worktreeRoot,
    cleanup: Boolean(options.cleanup),
    createWorktree: options.createWorktree ?? createWorktree,
    removeWorktree: options.removeWorktree ?? removeWorktree,
    // runTieredTurn defaults to the exec transport (transport: undefined !==
    // "app-server"); fanout workers run headless, so exec is the right
    // default here.
    runTurn: options.runTurn ?? runTieredTurn
  };

  const concurrency = resolveConcurrency(options.concurrency);
  const outcomes = await runWithConcurrencyLimit(briefs, concurrency, (brief) => runFanoutWorker(brief, context));

  const results = [];
  const failed = [];
  const quotaExhausted = [];
  for (const outcome of outcomes) {
    if (outcome.bucket === "results") {
      results.push(outcome.entry);
    } else if (outcome.bucket === "failed") {
      failed.push(outcome.entry);
    } else {
      quotaExhausted.push(outcome.entry);
    }
  }

  return Object.freeze({
    results: Object.freeze(results),
    failed: Object.freeze(failed),
    quota_exhausted: Object.freeze(quotaExhausted)
  });
}
