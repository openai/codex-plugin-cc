import { resolveWorkspaceContext } from "./vcs/index.mjs";

export function resolveWorkspaceRoot(cwd, options = {}) {
  return resolveWorkspaceContext(cwd, options).workspaceRoot;
}
