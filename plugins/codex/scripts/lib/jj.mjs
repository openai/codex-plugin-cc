import { binaryAvailable, formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

function jj(cwd, args, options = {}) {
  return runCommand("jj", [
    "--no-pager",
    "--color=never",
    "--quiet",
    ...args
  ], { cwd, ...options });
}

function jjChecked(cwd, args, options = {}) {
  return runCommandChecked("jj", [
    "--no-pager",
    "--color=never",
    "--quiet",
    ...args
  ], { cwd, ...options });
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

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function buildForkPointRevset(baseRef) {
  return `fork_point((${baseRef}) | @)`;
}

function buildAdversarialCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence. This is a Jujutsu (jj) repository — if you need to run additional commands, use jj (not git).";
  }

  return "The repository context below is a lightweight summary (diff stat and changed file list). The full diff was too large to inline. Base your review on the provided summary, commit log, and changed file list. Do NOT attempt to run jj commands — the sandbox does not support them.";
}

function measureJjOutputBytes(cwd, args, maxBytes) {
  const result = jj(cwd, args, { maxBuffer: maxBytes + 1 });
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

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const statusOutput = jjChecked(cwd, ["diff", "--summary"]).stdout.trim();
  const changedFiles = state.staged;

  if (includeDiff) {
    const workingCopyDiff = jjChecked(cwd, ["diff", "--git"]).stdout;
    return {
      mode: "working-tree",
      summary: `Reviewing ${state.staged.length} changed file(s) in working copy.`,
      content: [
        formatSection("Git Status", statusOutput),
        formatSection("Staged Diff", workingCopyDiff),
        formatSection("Unstaged Diff", ""),
        formatSection("Untracked Files", "")
      ].join("\n"),
      changedFiles
    };
  } else {
    const diffStat = jjChecked(cwd, ["diff", "--stat"]).stdout.trim();
    return {
      mode: "working-tree",
      summary: `Reviewing ${state.staged.length} changed file(s) in working copy.`,
      content: [
        formatSection("Git Status", statusOutput),
        formatSection("Staged Diff Stat", diffStat),
        formatSection("Unstaged Diff Stat", ""),
        formatSection("Changed Files", changedFiles.join("\n")),
        formatSection("Untracked Files", "")
      ].join("\n"),
      changedFiles
    };
  }
}

function collectRangeContext(cwd, includeDiff, baseRef = "trunk()") {
  const comparisonBase = buildForkPointRevset(baseRef);
  const logOutput = jjChecked(cwd, [
    "log", "-r", `${comparisonBase}..@`, "--no-graph",
    "-T", 'change_id.short(8) ++ " " ++ description.first_line() ++ "\\n"'
  ]).stdout.trim();

  const diffStat = jjChecked(cwd, [
    "diff", "--from", comparisonBase, "--to", "@", "--stat"
  ]).stdout.trim();

  const changedFiles = jjChecked(cwd, [
    "diff", "--from", comparisonBase, "--to", "@", "--name-only"
  ]).stdout.trim().split("\n").filter(Boolean);

  const currentBranch = getCurrentBranch(cwd);

  return {
    mode: "branch",
    summary: `Reviewing changes on ${currentBranch} since the fork point with ${baseRef}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            jjChecked(cwd, ["diff", "--from", comparisonBase, "--to", "@", "--git"]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles
  };
}

export function ensureGitRepository(cwd) {
  const availability = binaryAvailable("jj");
  if (!availability.available) {
    throw new Error(
      "jj is not installed. Install Jujutsu (https://jj-vcs.dev) and retry."
    );
  }
  const result = jj(cwd, ["workspace", "root"]);
  if (result.status !== 0) {
    throw new Error(
      "This command must run inside a Git or Jujutsu repository."
    );
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return jjChecked(cwd, ["workspace", "root"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const trunkResult = jj(cwd, [
    "log", "-r", "trunk()", "--no-graph", "-T", "commit_id"
  ]);
  if (trunkResult.status === 0 && !/^0+$/.test(trunkResult.stdout.trim())) {
    return "trunk()";
  }

  const candidates = ["main", "master", "trunk"];
  for (const name of candidates) {
    const result = jj(cwd, [
      "log", "-r", name, "--no-graph", "-T", "commit_id"
    ]);
    if (result.status === 0 && result.stdout.trim() && !/^0+$/.test(result.stdout.trim())) {
      return name;
    }
  }

  throw new Error(
    "Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree."
  );
}

export function getCurrentBranch(cwd) {
  const bookmarks = jjChecked(cwd, [
    "log", "-r", "@", "--no-graph",
    "-T", 'local_bookmarks.map(|b| b.name()).join(", ")'
  ]).stdout.trim();

  if (bookmarks) {
    return bookmarks.split(", ")[0];
  }

  return jjChecked(cwd, [
    "log", "-r", "@", "--no-graph", "-T", "change_id.short(8)"
  ]).stdout.trim();
}

export function getWorkingTreeState(cwd) {
  const summaryOutput = jjChecked(cwd, ["diff", "--summary"]).stdout.trim();
  const staged = jjChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  return {
    staged,
    unstaged: [],
    untracked: [],
    isDirty: summaryOutput.length > 0
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

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    diffBytes = measureJjOutputBytes(repoRoot, ["diff", "--git"], maxInlineDiffBytes);
    includeDiff =
      options.includeDiff ??
      (state.staged.length <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectWorkingTreeContext(repoRoot, state, { includeDiff });
  } else {
    const comparisonBase = buildForkPointRevset(target.baseRef);
    const fileCount = jjChecked(repoRoot, [
      "diff", "--from", comparisonBase, "--to", "@", "--name-only"
    ]).stdout.trim().split("\n").filter(Boolean).length;
    diffBytes = measureJjOutputBytes(
      repoRoot,
      ["diff", "--from", comparisonBase, "--to", "@", "--git"],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectRangeContext(repoRoot, includeDiff, target.baseRef);
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff }),
    ...details
  };
}
