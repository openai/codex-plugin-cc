import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { runCommand, runCommandChecked } from "./process.mjs";

/**
 * Try to run a git command; on buffer-limit failure return null instead of
 * throwing. Other errors (permissions, bad rev, corruption) are re-thrown
 * so they don't get silently downgraded to stat-only review context.
 */
function gitTry(cwd, args) {
  const result = runCommand("git", args, { cwd });
  if (result.error) {
    const code = result.error.code ?? "";
    // ENOBUFS / ERR_CHILD_PROCESS_STDIO_MAXBUFFER are buffer-limit failures.
    if (code === "ENOBUFS" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return null;
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${result.status}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}

const MAX_UNTRACKED_BYTES = 24 * 1024;

/**
 * Maximum character length for assembled review content.
 * The Codex API input limit is 1,048,576 characters. We reserve headroom for
 * the prompt template and other metadata that wrap the review content.
 */
export const MAX_REVIEW_CONTENT_CHARS = 800_000;

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options });
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  const stat = fs.statSync(absolutePath);
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  const buffer = fs.readFileSync(absolutePath);
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

/**
 * Estimate the byte size of the text portion of a diff from `--numstat` output.
 *
 * Each line is: `<insertions>\t<deletions>\t<path>`
 * Binary files show: `-\t-\t<path>` — these are skipped because `git diff`
 * with `--binary` encodes them separately, and the text estimate should only
 * reflect reviewable text hunks. The caller can check `hasBinaryFiles` to
 * decide whether to filter binary entries from the full diff later.
 *
 * We assume ~80 bytes per changed line (context + hunk headers + content).
 */
export function estimateDiffBytes(numstatOutput) {
  if (!numstatOutput.trim()) {
    return { bytes: 0, hasBinaryFiles: false };
  }
  let totalBytes = 0;
  let hasBinaryFiles = false;
  for (const line of numstatOutput.trim().split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) {
      continue;
    }
    const [ins, del] = parts;
    if (ins === "-" && del === "-") {
      hasBinaryFiles = true;
      continue;
    }
    const insertions = parseInt(ins, 10) || 0;
    const deletions = parseInt(del, 10) || 0;
    totalBytes += (insertions + deletions) * 80;
  }
  return { bytes: totalBytes, hasBinaryFiles };
}

/**
 * Collect untracked file bodies up to a byte budget.
 * Once the budget is exhausted, a single summary line is appended
 * (not per-file placeholders) to keep the output strictly bounded.
 */
function collectUntrackedBodies(cwd, files, budget) {
  const parts = [];
  let used = 0;
  let skippedCount = 0;
  for (const file of files) {
    if (used >= budget) {
      skippedCount++;
      continue;
    }
    const body = formatUntrackedFile(cwd, file);
    if (used + body.length > budget) {
      // Skip this file but keep scanning — smaller files may still fit.
      skippedCount++;
      continue;
    }
    parts.push(body);
    used += body.length;
  }
  if (skippedCount > 0) {
    parts.push(`(${skippedCount} untracked file(s) omitted — content budget exhausted)`);
  }
  return parts.join("\n\n");
}

/**
 * Hard-cap content to MAX_REVIEW_CONTENT_CHARS.
 * If truncated, appends a note so the reviewer knows the output is incomplete.
 */
function enforceContentLimit(content) {
  if (content.length <= MAX_REVIEW_CONTENT_CHARS) {
    return content;
  }
  const truncNote = "\n\n> **Note:** Review content was truncated to stay within the input size limit.";
  return content.slice(0, MAX_REVIEW_CONTENT_CHARS - truncNote.length) + truncNote;
}

function collectWorkingTreeContext(cwd, state) {
  const status = gitChecked(cwd, ["status", "--short"]).stdout.trim();

  // Check diff sizes BEFORE reading full diffs to avoid ENOBUFS on large changes.
  // Use --numstat to detect binary files (reported as "-\t-") and estimate text size.
  const stagedNumstat = gitChecked(cwd, ["diff", "--cached", "--numstat"]).stdout.trim();
  const unstagedNumstat = gitChecked(cwd, ["diff", "--numstat"]).stdout.trim();
  const stagedEstimate = estimateDiffBytes(stagedNumstat);
  const unstagedEstimate = estimateDiffBytes(unstagedNumstat);
  const estimatedBytes = stagedEstimate.bytes + unstagedEstimate.bytes;
  const diffLikelyOversized = estimatedBytes > MAX_REVIEW_CONTENT_CHARS;

  if (diffLikelyOversized) {
    const stagedStat = gitChecked(cwd, ["diff", "--cached", "--stat"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--stat"]).stdout.trim();
    const headerParts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff (stat only — full diff too large)", stagedStat || "(none)"),
      formatSection("Unstaged Diff (stat only — full diff too large)", unstagedStat || "(none)")
    ].join("\n");
    // Budget remaining for untracked files after header + note.
    const untrackedBudget = Math.max(0, MAX_REVIEW_CONTENT_CHARS - headerParts.length - 200);
    const untrackedBody = collectUntrackedBodies(cwd, state.untracked, untrackedBudget);
    const content = [headerParts, formatSection("Untracked Files", untrackedBody)].join("\n") +
      "\n\n> **Note:** The full diff exceeded the input size limit and was replaced with `--stat` summaries. " +
      "Use shell commands (`git diff`, `git diff --cached`) to inspect the complete changes.";

    return {
      mode: "working-tree",
      summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
      content: enforceContentLimit(content)
    };
  }

  // When binary files are present, use text-only diff to avoid buffering
  // large binary patches. Binary entries get a "(binary file)" note in the diff.
  const hasBinary = stagedEstimate.hasBinaryFiles || unstagedEstimate.hasBinaryFiles;
  const diffFlags = hasBinary
    ? ["--no-ext-diff", "--submodule=diff"]
    : ["--binary", "--no-ext-diff", "--submodule=diff"];

  // Use gitTry so oversized single-line diffs (ENOBUFS) degrade to --stat
  // instead of crashing the entire review collection.
  const stagedDiff = gitTry(cwd, ["diff", "--cached", ...diffFlags]);
  const unstagedDiff = gitTry(cwd, ["diff", ...diffFlags]);

  if (stagedDiff === null || unstagedDiff === null) {
    // Diff read failed (likely ENOBUFS) — fall back to stat-only.
    const stagedStat = gitChecked(cwd, ["diff", "--cached", "--stat"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--stat"]).stdout.trim();
    const headerParts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff (stat only — diff read failed)", stagedStat || "(none)"),
      formatSection("Unstaged Diff (stat only — diff read failed)", unstagedStat || "(none)")
    ].join("\n");
    const untrackedBudget = Math.max(0, MAX_REVIEW_CONTENT_CHARS - headerParts.length - 200);
    const untrackedBody = collectUntrackedBodies(cwd, state.untracked, untrackedBudget);
    const content = [headerParts, formatSection("Untracked Files", untrackedBody)].join("\n") +
      "\n\n> **Note:** The full diff could not be read (possibly too large) and was replaced with `--stat` summaries. " +
      "Use shell commands (`git diff`, `git diff --cached`) to inspect the complete changes.";

    return {
      mode: "working-tree",
      summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
      content: enforceContentLimit(content)
    };
  }
  const untrackedBody = collectUntrackedBodies(cwd, state.untracked, MAX_REVIEW_CONTENT_CHARS);

  let content = [
    formatSection("Git Status", status),
    formatSection("Staged Diff", stagedDiff),
    formatSection("Unstaged Diff", unstagedDiff),
    formatSection("Untracked Files", untrackedBody)
  ].join("\n");

  // Safety net: if the estimate was wrong and assembled content is still too large.
  if (content.length > MAX_REVIEW_CONTENT_CHARS) {
    const stagedStat = gitChecked(cwd, ["diff", "--cached", "--stat"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--stat"]).stdout.trim();
    const headerParts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff (stat only — full diff too large)", stagedStat || "(none)"),
      formatSection("Unstaged Diff (stat only — full diff too large)", unstagedStat || "(none)")
    ].join("\n");
    const remainingBudget = Math.max(0, MAX_REVIEW_CONTENT_CHARS - headerParts.length - 200);
    const trimmedUntracked = collectUntrackedBodies(cwd, state.untracked, remainingBudget);
    content = [headerParts, formatSection("Untracked Files", trimmedUntracked)].join("\n") +
      "\n\n> **Note:** The full diff exceeded the input size limit and was replaced with `--stat` summaries. " +
      "Use shell commands (`git diff`, `git diff --cached`) to inspect the complete changes.";
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: enforceContentLimit(content)
  };
}

function collectBranchContext(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  const commitRange = `${mergeBase}..HEAD`;
  const currentBranch = getCurrentBranch(cwd);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", commitRange]).stdout.trim();

  // Check diff size BEFORE reading full diff to avoid ENOBUFS on large branches.
  // Use --numstat to detect binary files that shortstat would miss.
  const numstat = gitChecked(cwd, ["diff", "--numstat", commitRange]).stdout.trim();
  const estimate = estimateDiffBytes(numstat);

  if (estimate.bytes > MAX_REVIEW_CONTENT_CHARS) {
    const content = [
      formatSection("Commit Log", logOutput),
      formatSection("Diff Stat", diffStat),
      formatSection("Branch Diff (stat only — full diff too large)", diffStat)
    ].join("\n") +
      "\n\n> **Note:** The full branch diff exceeded the input size limit and was replaced with `--stat` summaries. " +
      "Use shell commands (`git diff " + commitRange + "`) to inspect the complete changes.";

    return {
      mode: "branch",
      summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${mergeBase}.`,
      content: enforceContentLimit(content)
    };
  }

  // When binary files are present, skip --binary to avoid buffering large patches.
  const diffFlags = estimate.hasBinaryFiles
    ? ["--no-ext-diff", "--submodule=diff", commitRange]
    : ["--binary", "--no-ext-diff", "--submodule=diff", commitRange];

  // Use gitTry so oversized single-line diffs (ENOBUFS) degrade to --stat.
  const diff = gitTry(cwd, ["diff", ...diffFlags]);

  if (diff === null) {
    const content = [
      formatSection("Commit Log", logOutput),
      formatSection("Diff Stat", diffStat),
      formatSection("Branch Diff (stat only — diff read failed)", diffStat)
    ].join("\n") +
      "\n\n> **Note:** The full branch diff could not be read (possibly too large) and was replaced with `--stat` summaries. " +
      "Use shell commands (`git diff " + commitRange + "`) to inspect the complete changes.";

    return {
      mode: "branch",
      summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${mergeBase}.`,
      content: enforceContentLimit(content)
    };
  }

  let content = [
    formatSection("Commit Log", logOutput),
    formatSection("Diff Stat", diffStat),
    formatSection("Branch Diff", diff)
  ].join("\n");

  // Safety net: if the estimate was wrong and assembled content is still too large.
  if (content.length > MAX_REVIEW_CONTENT_CHARS) {
    content = [
      formatSection("Commit Log", logOutput),
      formatSection("Diff Stat", diffStat),
      formatSection("Branch Diff (stat only — full diff too large)", diffStat)
    ].join("\n") +
      "\n\n> **Note:** The full branch diff exceeded the input size limit and was replaced with `--stat` summaries. " +
      "Use shell commands (`git diff " + commitRange + "`) to inspect the complete changes.";
  }

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${mergeBase}.`,
    content: enforceContentLimit(content)
  };
}

export function collectReviewContext(cwd, target) {
  const repoRoot = getRepoRoot(cwd);
  const state = getWorkingTreeState(cwd);
  const currentBranch = getCurrentBranch(cwd);
  let details;

  if (target.mode === "working-tree") {
    details = collectWorkingTreeContext(repoRoot, state);
  } else {
    details = collectBranchContext(repoRoot, target.baseRef);
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    ...details
  };
}
