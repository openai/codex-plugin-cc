import {
  collectReviewContext as collectGitReviewContext,
  ensureGitRepository,
  getCurrentBranch,
  getWorkingTreeState,
  resolveReviewTarget as resolveGitReviewTarget
} from "../git.mjs";
import {
  DEFAULT_INLINE_DIFF_MAX_BYTES,
  DEFAULT_INLINE_DIFF_MAX_FILES,
  recommendReviewMode
} from "./review-context.mjs";

export function probeGit(cwd) {
  try {
    const repoRoot = ensureGitRepository(cwd);
    return {
      workspaceRoot: repoRoot,
      vcsKind: "git",
      vcsRoot: repoRoot,
      scopeRoot: repoRoot
    };
  } catch {
    return null;
  }
}

export function requireGit(cwd) {
  const repoRoot = ensureGitRepository(cwd);
  return {
    workspaceRoot: repoRoot,
    vcsKind: "git",
    vcsRoot: repoRoot,
    scopeRoot: repoRoot
  };
}

export const gitAdapter = {
  kind: "git",

  getCurrentBranch(context) {
    return getCurrentBranch(context.vcsRoot);
  },

  getDefaultBase() {
    return null;
  },

  getWorkingTreeState(context) {
    return getWorkingTreeState(context.vcsRoot);
  },

  resolveReviewTarget(context, options = {}) {
    return resolveGitReviewTarget(context.vcsRoot, options);
  },

  collectReviewContext(context, target, options = {}) {
    return {
      vcs: "git",
      workspaceRoot: context.workspaceRoot,
      ...collectGitReviewContext(context.vcsRoot, target, options)
    };
  },

  estimateReview(context, target, options = {}) {
    const maxInlineFiles = options.maxInlineFiles ?? DEFAULT_INLINE_DIFF_MAX_FILES;
    const maxInlineDiffBytes = options.maxInlineDiffBytes ?? DEFAULT_INLINE_DIFF_MAX_BYTES;
    const reviewContext = this.collectReviewContext(context, target, {
      ...options,
      includeDiff: false,
      maxInlineFiles,
      maxInlineDiffBytes
    });
    return {
      vcs: "git",
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
