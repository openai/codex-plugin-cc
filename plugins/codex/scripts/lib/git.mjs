import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
// Inline-diff embeds full file contents into the prompt and pins outputSchema
// on a single turn — there is no recovery if the model wants to investigate
// before producing the verdict. Keep this path narrow: only single-file
// reviews of small diffs use it. Anything larger falls through to the
// two-phase self-collect path which can tolerate exploratory turns.
const DEFAULT_INLINE_DIFF_MAX_FILES = 1;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;
// Multi-turn investigation can tolerate a much larger inline payload than the
// single-shot path: the model reads the diff as evidence and still has
// follow-up turns for anything it needs beyond it. 1MB is a safe share of a
// 272K-token context window.
const DEFAULT_INVESTIGATION_INLINE_MAX_BYTES = 1024 * 1024;

// Git is directly executable on Windows. Repository-derived arguments must never pass through a shell.
function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options, shell: false });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options, shell: false });
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function normalizeInvestigationInlineMaxBytes(value) {
  const raw = value ?? process.env.CODEX_COMPANION_INVESTIGATION_INLINE_MAX_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_INVESTIGATION_INLINE_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
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

// Single source of truth for whether an untracked file's contents can be
// embedded into the inline prompt. Returns either a `skipped` reason (the file
// is a directory, too large, binary, or unreadable) or the file `content`.
function classifyUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return { skipped: "broken symlink or unreadable file" };
  }
  if (stat.isDirectory()) {
    return { skipped: "directory" };
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return { skipped: `${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit` };
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return { skipped: "broken symlink or unreadable file" };
  }
  if (!isProbablyText(buffer)) {
    return { skipped: "binary file" };
  }

  return { content: buffer.toString("utf8").trimEnd() };
}

// True when at least one untracked file's contents cannot be embedded inline.
// An untracked file never appears in `git diff`, so a single skipped untracked
// file otherwise looks like a 1-file, 0-byte diff and slips onto the inline
// path — where the prompt embeds only a `(skipped: ...)` marker and forbids
// shell, leaving the reviewer nothing to inspect.
function hasSkippedUntrackedContent(cwd, untracked) {
  return untracked.some((file) => Boolean(classifyUntrackedFile(cwd, file).skipped));
}

function formatUntrackedFile(cwd, relativePath) {
  const classified = classifyUntrackedFile(cwd, relativePath);
  if (classified.skipped) {
    return `### ${relativePath}\n(skipped: ${classified.skipped})`;
  }
  return [`### ${relativePath}`, "```", classified.content, "```"].join("\n");
}

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);

  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Untracked Files", untrackedBody)
    ];
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles
  };
}

function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles,
    comparison
  };
}

function buildAdversarialCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence.";
  }

  if (options.investigationInline) {
    const fed =
      "The full diff is embedded below as primary evidence — do not re-derive it with git commands. Run read-only commands only when you need context beyond the diff itself: surrounding code, callers, history, or tests.";
    // Untracked files never appear in `git diff`, and oversized/binary ones are
    // reduced to a `(skipped: ...)` marker. Without this clause the fed wording
    // would claim complete evidence while telling the model not to go looking.
    if (options.hasSkippedUntracked) {
      return `${fed} Some untracked files could not be embedded — read them directly with read-only commands.`;
    }
    return fed;
  }

  return "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.";
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  const investigationInlineMaxBytes = normalizeInvestigationInlineMaxBytes(options.investigationInlineMaxBytes);
  // Measure up to whichever budget is larger so a diff that overflows the
  // single-shot cap still yields a real byte count for the investigation check.
  const measureCap = Math.max(maxInlineDiffBytes, investigationInlineMaxBytes);
  let details;
  // singleShotInline decides inline-diff vs self-collect routing; investigationInline
  // decides whether the self-collect prompt carries the diff. Keep them distinct.
  let singleShotInline;
  let investigationInline;
  let diffBytes;
  // Only meaningful in working-tree mode; a branch diff ignores the working tree.
  let fedDiffOmitsUntracked = false;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    // hasSkippedUntrackedContent() stats and reads every untracked file, and two
    // decisions below consult it. Memoize so it runs at most once, and keep it
    // lazy so neither decision pays for it when a cheaper conjunct already lost.
    let skippedUntracked = null;
    const hasSkippedUntracked = () => {
      if (skippedUntracked === null) {
        skippedUntracked = hasSkippedUntrackedContent(repoRoot, state.untracked);
      }
      return skippedUntracked;
    };
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]
      ],
      measureCap
    );
    singleShotInline =
      options.includeDiff ??
      (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <= maxInlineFiles &&
        diffBytes <= maxInlineDiffBytes &&
        !hasSkippedUntracked());
    // Only the byte bound matters here: skipped untracked content is fine
    // because the multi-turn path still has read-only shell to inspect it.
    investigationInline =
      options.includeDiff === undefined && !singleShotInline && diffBytes <= investigationInlineMaxBytes;
    // The fed diff is then incomplete, so the guidance must say so rather than
    // claim the embedded diff is the whole change.
    fedDiffOmitsUntracked = investigationInline && hasSkippedUntracked();
    details = collectWorkingTreeContext(repoRoot, state, {
      includeDiff: singleShotInline || investigationInline
    });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const fileCount = gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
      measureCap
    );
    singleShotInline = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    investigationInline =
      options.includeDiff === undefined && !singleShotInline && diffBytes <= investigationInlineMaxBytes;
    details = collectBranchContext(repoRoot, target.baseRef, {
      includeDiff: singleShotInline || investigationInline,
      comparison
    });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: singleShotInline ? "inline-diff" : "self-collect",
    investigationInline,
    collectionGuidance: buildAdversarialCollectionGuidance({
      includeDiff: singleShotInline,
      investigationInline,
      hasSkippedUntracked: fedDiffOmitsUntracked
    }),
    ...details
  };
}
