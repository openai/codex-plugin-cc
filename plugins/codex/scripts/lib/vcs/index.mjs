import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { arcAdapter, probeArc, requireArc } from "./arc.mjs";
import { gitAdapter, probeGit, requireGit } from "./git.mjs";

export const VCS_ENV = "CODEX_COMPANION_VCS";
export const WORKSPACE_ROOT_ENV = "CODEX_COMPANION_WORKSPACE_ROOT";

const SUPPORTED_VCS = new Set(["auto", "git", "arc"]);

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function normalizeVcs(value) {
  const normalized = String(value ?? "auto").trim().toLowerCase() || "auto";
  if (!SUPPORTED_VCS.has(normalized)) {
    throw new Error(`Unsupported VCS "${value}". Use one of: auto, git, arc.`);
  }
  return normalized;
}

function contextFromBinding(kind, workspaceRoot) {
  const canonicalRoot = canonicalPath(workspaceRoot);
  return {
    workspaceRoot: canonicalRoot,
    vcsKind: kind,
    vcsRoot: kind === "git" ? canonicalRoot : null,
    scopeRoot: canonicalRoot
  };
}

export function resolveWorkspaceContext(cwd, options = {}) {
  const env = options.env ?? process.env;
  const explicitVcs = options.vcs == null ? null : normalizeVcs(options.vcs);
  const envVcs = normalizeVcs(env[VCS_ENV] ?? "auto");
  const requestedVcs = explicitVcs ?? envVcs;
  const boundRoot = !explicitVcs ? env[WORKSPACE_ROOT_ENV] : null;

  if (boundRoot) {
    return contextFromBinding(envVcs === "auto" ? null : envVcs, boundRoot);
  }

  const openedWorkspace = canonicalPath(cwd);
  if (requestedVcs === "arc") {
    return requireArc(openedWorkspace);
  }
  if (requestedVcs === "git") {
    return requireGit(openedWorkspace);
  }

  const arcContext = probeArc(openedWorkspace);
  if (arcContext) {
    return {
      ...arcContext,
      workspaceRoot: openedWorkspace,
      scopeRoot: openedWorkspace
    };
  }
  const gitContext = probeGit(openedWorkspace);
  if (gitContext) {
    return gitContext;
  }
  return {
    workspaceRoot: openedWorkspace,
    vcsKind: null,
    vcsRoot: null,
    scopeRoot: openedWorkspace
  };
}

export function requireReviewWorkspace(cwd, options = {}) {
  const context = resolveWorkspaceContext(cwd, options);
  if (!context.vcsKind) {
    throw new Error("This review must run inside a supported Yandex Arc or Git workspace.");
  }
  return context;
}

export function getVcsAdapter(context) {
  if (context.vcsKind === "arc") {
    return arcAdapter;
  }
  if (context.vcsKind === "git") {
    return gitAdapter;
  }
  throw new Error("The opened workspace is not bound to a supported VCS.");
}

export function resolveReviewTarget(context, options = {}) {
  return getVcsAdapter(context).resolveReviewTarget(context, options);
}

export function collectReviewContext(context, target, options = {}) {
  return getVcsAdapter(context).collectReviewContext(context, target, options);
}

export function estimateReview(context, target, options = {}) {
  return getVcsAdapter(context).estimateReview(context, target, options);
}
