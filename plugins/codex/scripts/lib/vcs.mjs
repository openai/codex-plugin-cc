import fs from "node:fs";
import path from "node:path";

import { runCommand } from "./process.mjs";
import * as gitBackend from "./git.mjs";
import * as jjBackend from "./jj.mjs";

const vcsCache = new Map();

function findDirUpward(startDir, dirName) {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, dirName))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function detectVcs(cwd) {
  const resolved = path.resolve(cwd);
  if (vcsCache.has(resolved)) return vcsCache.get(resolved);

  let kind = null;
  const jjRoot = findDirUpward(resolved, ".jj");
  const gitRoot = findDirUpward(resolved, ".git");
  if (jjRoot && gitRoot) {
    // Pick the closer (deeper) root; if equal depth, prefer jj (colocated repo)
    kind = gitRoot.length > jjRoot.length ? "git" : "jj";
  } else if (jjRoot) {
    kind = "jj";
  } else if (gitRoot) {
    kind = "git";
  } else {
    const jjResult = runCommand("jj", ["--no-pager", "--color=never", "--quiet", "--ignore-working-copy", "--at-operation", "@", "workspace", "root"], { cwd: resolved });
    if (jjResult.status === 0 && !jjResult.error) {
      kind = "jj";
    } else {
      const gitResult = runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: resolved });
      if (gitResult.status === 0 && !gitResult.error) {
        kind = "git";
      }
    }
  }

  if (kind === null) {
    throw new Error("This command must run inside a Git or Jujutsu repository.");
  }

  vcsCache.set(resolved, kind);
  return kind;
}

function getBackend(cwd) {
  return detectVcs(cwd) === "jj" ? jjBackend : gitBackend;
}

export function ensureGitRepository(cwd) {
  return getBackend(cwd).ensureGitRepository(cwd);
}

export function getRepoRoot(cwd) {
  return getBackend(cwd).getRepoRoot(cwd);
}

export function detectDefaultBranch(cwd) {
  return getBackend(cwd).detectDefaultBranch(cwd);
}

export function getCurrentBranch(cwd) {
  return getBackend(cwd).getCurrentBranch(cwd);
}

export function getWorkingTreeState(cwd) {
  return getBackend(cwd).getWorkingTreeState(cwd);
}

export function resolveReviewTarget(cwd, options = {}) {
  return getBackend(cwd).resolveReviewTarget(cwd, options);
}

export function collectReviewContext(cwd, target, options = {}) {
  return getBackend(cwd).collectReviewContext(cwd, target, options);
}
