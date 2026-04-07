import {
  createWorktree,
  removeWorktree,
  deleteWorktreeBranch,
  getWorktreeDiff,
  applyWorktreePatch,
  ensureGitRepository
} from "./git.mjs";

export function createWorktreeSession(cwd) {
  const repoRoot = ensureGitRepository(cwd);
  return createWorktree(repoRoot);
}

export function diffWorktreeSession(session) {
  return getWorktreeDiff(session.worktreePath, session.baseCommit);
}

export function cleanupWorktreeSession(session, { keep = false } = {}) {
  if (keep) {
    const result = applyWorktreePatch(session.repoRoot, session.worktreePath, session.baseCommit);
    if (!result.applied && result.detail !== "No changes to apply.") {
      return result;
    }
    removeWorktree(session.repoRoot, session.worktreePath);
    deleteWorktreeBranch(session.repoRoot, session.branch);
    return result;
  }
  removeWorktree(session.repoRoot, session.worktreePath);
  deleteWorktreeBranch(session.repoRoot, session.branch);
  return { applied: false, detail: "Worktree discarded." };
}
