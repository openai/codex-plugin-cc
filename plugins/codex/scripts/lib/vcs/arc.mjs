import fs from "node:fs";
import path from "node:path";

import { formatCommandFailure, runCommand } from "../process.mjs";
import {
  DEFAULT_INLINE_DIFF_MAX_BYTES,
  DEFAULT_INLINE_DIFF_MAX_FILES,
  formatBoundedTextFile,
  formatSection,
  isPathInside,
  listUniqueFiles,
  normalizeMaxInlineDiffBytes,
  normalizeMaxInlineFiles,
  recommendReviewMode
} from "./review-context.mjs";

function arc(cwd, args, options = {}) {
  return runCommand("arc", args, { cwd, ...options, shell: false });
}

function arcChecked(cwd, args, options = {}) {
  const result = arc(cwd, args, options);
  const errorCode = result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code;
  if (errorCode === "ENOENT") {
    throw new Error("Yandex Arc CLI is not installed or is not available on PATH.");
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

function parseJsonObject(text, label) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned malformed JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} returned an unexpected JSON value.`);
  }
  return parsed;
}

export function parseArcInfo(text) {
  const parsed = parseJsonObject(text, "arc info --json");
  return {
    ...parsed,
    branch: typeof parsed.branch === "string" && parsed.branch.trim() ? parsed.branch.trim() : null
  };
}

function normalizeStatusEntry(entry, section) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.path !== "string") {
    throw new Error(`arc status --json returned an invalid ${section} entry.`);
  }
  const entryPath = entry.path.trim();
  if (!entryPath) {
    throw new Error(`arc status --json returned an empty path in ${section}.`);
  }
  return {
    section,
    path: entryPath,
    status: entry.status == null ? "" : String(entry.status),
    type: entry.type == null ? "" : String(entry.type)
  };
}

export function parseArcStatus(text) {
  const parsed = parseJsonObject(text, "arc status --json");
  const result = {};
  for (const section of ["staged", "changed", "untracked"]) {
    if (!Array.isArray(parsed[section])) {
      throw new Error(`arc status --json response is missing the ${section} array.`);
    }
    result[section] = parsed[section].map((entry) => normalizeStatusEntry(entry, section));
  }
  return result;
}

function normalizedPathParts(value) {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    return null;
  }
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) {
    return null;
  }
  return parts;
}

export function mapArcPathToScope(scopeRoot, repositoryRelativePath, options = {}) {
  const pathParts = normalizedPathParts(repositoryRelativePath);
  if (!pathParts) {
    return null;
  }

  const scopeParts = path.resolve(scopeRoot).split(path.sep).filter(Boolean);
  const maxMatch = Math.min(scopeParts.length, pathParts.length);
  let matchingPrefixLength = 0;
  for (let length = maxMatch; length >= 1; length -= 1) {
    const scopeSuffix = scopeParts.slice(-length);
    const arcPrefix = pathParts.slice(0, length);
    if (scopeSuffix.every((part, index) => part === arcPrefix[index])) {
      matchingPrefixLength = length;
      break;
    }
  }
  if (matchingPrefixLength === 0) {
    return null;
  }

  const candidate = path.resolve(scopeRoot, ...pathParts.slice(matchingPrefixLength));
  if (!isPathInside(path.resolve(scopeRoot), candidate)) {
    return null;
  }
  if (options.requireExists !== false && !fs.existsSync(candidate)) {
    return null;
  }
  return candidate;
}

function readArcInfo(cwd) {
  return parseArcInfo(arcChecked(cwd, ["info", "--json"]).stdout);
}

export function probeArc(cwd) {
  const result = arc(cwd, ["info", "--json"]);
  const errorCode = result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code;
  if (errorCode === "ENOENT" || result.status !== 0 || result.error) {
    return null;
  }
  try {
    const info = parseArcInfo(result.stdout);
    const workspaceRoot = path.resolve(cwd);
    return {
      workspaceRoot,
      vcsKind: "arc",
      vcsRoot: null,
      scopeRoot: workspaceRoot,
      info
    };
  } catch {
    return null;
  }
}

export function requireArc(cwd) {
  const info = readArcInfo(cwd);
  const workspaceRoot = path.resolve(cwd);
  return {
    workspaceRoot,
    vcsKind: "arc",
    vcsRoot: null,
    scopeRoot: workspaceRoot,
    info
  };
}

function getArcStatus(context) {
  const parsed = parseArcStatus(
    arcChecked(context.scopeRoot, ["status", "--json", context.scopeRoot]).stdout
  );
  const staged = parsed.staged.map((entry) => entry.path);
  const changed = parsed.changed.map((entry) => entry.path);
  const untracked = parsed.untracked.map((entry) => entry.path);
  return {
    ...parsed,
    stagedPaths: staged,
    changedPaths: changed,
    untrackedPaths: untracked,
    isDirty: staged.length > 0 || changed.length > 0 || untracked.length > 0
  };
}

function resolveArcReviewTarget(context, options = {}) {
  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against local ${baseRef}`,
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
    return {
      mode: "branch",
      label: "branch diff against local trunk",
      baseRef: "trunk",
      explicit: true
    };
  }
  if (getArcStatus(context).isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }
  return {
    mode: "branch",
    label: "branch diff against local trunk",
    baseRef: "trunk",
    explicit: false
  };
}

function measureArcOutputBytes(cwd, args, maxBytes) {
  const result = arc(cwd, args, { maxBuffer: maxBytes + 1 });
  const errorCode = result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code;
  if (errorCode === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (errorCode === "ENOENT") {
    throw new Error("Yandex Arc CLI is not installed or is not available on PATH.");
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedArcOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureArcOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

function formatArcStatus(status) {
  return ["staged", "changed", "untracked"]
    .flatMap((section) =>
      status[section].map((entry) =>
        [`[${section}]`, entry.status, entry.type, entry.path].filter(Boolean).join(" ")
      )
    )
    .join("\n");
}

function formatArcUntrackedFile(context, repositoryRelativePath) {
  const absolutePath = mapArcPathToScope(context.scopeRoot, repositoryRelativePath);
  if (!absolutePath) {
    return `### ${repositoryRelativePath}\n(skipped: path cannot be proven to resolve inside the opened workspace)`;
  }
  return formatBoundedTextFile(repositoryRelativePath, absolutePath);
}

function collectWorkingTreeContext(context, status, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const changedFiles = listUniqueFiles(
    status.stagedPaths,
    status.changedPaths,
    status.untrackedPaths
  );
  const untrackedBody = status.untrackedPaths
    .map((file) => formatArcUntrackedFile(context, file))
    .join("\n\n");
  const parts = includeDiff
    ? [
        formatSection("Arc Status", formatArcStatus(status)),
        formatSection(
          "Staged Diff",
          arcChecked(context.scopeRoot, ["diff", "--cached", "--git", "--relative=."]).stdout
        ),
        formatSection(
          "Unstaged Diff",
          arcChecked(context.scopeRoot, ["diff", "--git", "--relative=."]).stdout
        ),
        formatSection("Untracked Files", untrackedBody)
      ]
    : [
        formatSection("Arc Status", formatArcStatus(status)),
        formatSection(
          "Staged Diff Stat",
          arcChecked(context.scopeRoot, ["diff", "--cached", "--stat", "--relative=."]).stdout
        ),
        formatSection(
          "Unstaged Diff Stat",
          arcChecked(context.scopeRoot, ["diff", "--stat", "--relative=."]).stdout
        ),
        formatSection("Changed Files", changedFiles.join("\n")),
        formatSection("Untracked Files", untrackedBody)
      ];
  return {
    mode: "working-tree",
    summary: `Reviewing ${status.stagedPaths.length} staged, ${status.changedPaths.length} changed, and ${status.untrackedPaths.length} untracked Arc file(s).`,
    content: parts.join("\n"),
    changedFiles
  };
}

function branchArgs(flag, baseRef) {
  return ["diff", "-B", flag, "--relative=.", baseRef, "HEAD"];
}

function collectBranchContext(context, target, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const changedFiles = arcChecked(
    context.scopeRoot,
    branchArgs("--name-only", target.baseRef)
  ).stdout.trim().split(/\r?\n/).filter(Boolean);
  const diffStat = arcChecked(context.scopeRoot, branchArgs("--stat", target.baseRef)).stdout.trim();
  const currentBranch = context.info?.branch ?? readArcInfo(context.scopeRoot).branch ?? "unknown";
  return {
    mode: "branch",
    summary: `Reviewing Arc branch ${currentBranch} against locally available ${target.baseRef} using merge-base semantics.`,
    content: includeDiff
      ? [
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            arcChecked(context.scopeRoot, branchArgs("--git", target.baseRef)).stdout
          )
        ].join("\n")
      : [
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles
  };
}

function buildArcCollectionGuidance(target, includeDiff) {
  if (includeDiff) {
    return "Use the scoped Yandex Arc context below as primary evidence.";
  }
  if (target.mode === "working-tree") {
    return [
      "The context below is a lightweight summary. Inspect only the opened project from its workspace directory.",
      "Use read-only `arc status --json .`, `arc diff --git --relative=.`, and `arc diff --cached --git --relative=.` commands.",
      "Do not run `arc root` or remove the `--relative=.` scope."
    ].join(" ");
  }
  return [
    "The context below is a lightweight summary. Inspect only the opened project from its workspace directory.",
    `Use the read-only command \`arc diff -B --git --relative=. ${target.baseRef} HEAD\`.`,
    "Do not run `arc root`, `arc fetch`, or remove the `--relative=.` scope."
  ].join(" ");
}

function collectArcReviewContext(context, target, options = {}) {
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "working-tree") {
    const status = getArcStatus(context);
    diffBytes = measureCombinedArcOutputBytes(
      context.scopeRoot,
      [
        ["diff", "--cached", "--git", "--relative=."],
        ["diff", "--git", "--relative=."]
      ],
      maxInlineDiffBytes
    );
    const fileCount = listUniqueFiles(
      status.stagedPaths,
      status.changedPaths,
      status.untrackedPaths
    ).length;
    includeDiff = options.includeDiff ?? (
      fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes
    );
    details = collectWorkingTreeContext(context, status, { includeDiff });
  } else {
    const changedFiles = arcChecked(
      context.scopeRoot,
      branchArgs("--name-only", target.baseRef)
    ).stdout.trim().split(/\r?\n/).filter(Boolean);
    diffBytes = measureArcOutputBytes(
      context.scopeRoot,
      branchArgs("--git", target.baseRef),
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (
      changedFiles.length <= maxInlineFiles && diffBytes <= maxInlineDiffBytes
    );
    details = collectBranchContext(context, target, { includeDiff });
  }

  return {
    vcs: "arc",
    cwd: context.workspaceRoot,
    workspaceRoot: context.workspaceRoot,
    repoRoot: context.workspaceRoot,
    branch: context.info?.branch ?? "unknown",
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildArcCollectionGuidance(target, includeDiff),
    ...details
  };
}

export const arcAdapter = {
  kind: "arc",

  getCurrentBranch(context) {
    return context.info?.branch ?? readArcInfo(context.scopeRoot).branch ?? "unknown";
  },

  getDefaultBase() {
    return "trunk";
  },

  getWorkingTreeState(context) {
    return getArcStatus(context);
  },

  resolveReviewTarget(context, options = {}) {
    return resolveArcReviewTarget(context, options);
  },

  collectReviewContext(context, target, options = {}) {
    return collectArcReviewContext(context, target, options);
  },

  estimateReview(context, target, options = {}) {
    const maxInlineFiles = options.maxInlineFiles ?? DEFAULT_INLINE_DIFF_MAX_FILES;
    const maxInlineDiffBytes = options.maxInlineDiffBytes ?? DEFAULT_INLINE_DIFF_MAX_BYTES;
    const reviewContext = collectArcReviewContext(context, target, {
      ...options,
      includeDiff: false,
      maxInlineFiles,
      maxInlineDiffBytes
    });
    return {
      vcs: "arc",
      target,
      fileCount: reviewContext.fileCount,
      diffBytes: reviewContext.diffBytes,
      isEmpty: reviewContext.fileCount === 0 && reviewContext.diffBytes === 0,
      recommendedMode: recommendReviewMode({
        fileCount: reviewContext.fileCount,
        diffBytes: reviewContext.diffBytes,
        maxInlineFiles,
        maxInlineDiffBytes
      })
    };
  }
};
