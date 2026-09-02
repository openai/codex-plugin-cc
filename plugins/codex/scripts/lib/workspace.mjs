import fs from "node:fs";
import path from "node:path";

function resolveGitDirectory(candidatePath) {
  const candidateStats = fs.statSync(candidatePath);
  if (candidateStats.isDirectory()) {
    return fs.realpathSync.native(candidatePath);
  }
  if (!candidateStats.isFile()) {
    return null;
  }

  const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(fs.readFileSync(candidatePath, "utf8"));
  if (!match) {
    return null;
  }
  const target = path.resolve(path.dirname(candidatePath), match[1]);
  return fs.statSync(target).isDirectory() ? fs.realpathSync.native(target) : null;
}

function stripConfigComment(value) {
  let quote = null;
  let escaping = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#" || character === ";") {
      return value.slice(0, index).trimEnd();
    }
  }
  return value;
}

function parseConfigValue(value) {
  const uncommented = stripConfigComment(value).trim();
  const quoted = /^(?:"((?:\\.|[^"\\])*)"|'([^']*)')$/.exec(uncommented);
  if (!quoted) return uncommented;
  return (quoted[1] ?? quoted[2]).replace(/\\([\\"])/g, "$1");
}

function readConfiguredWorkTree(gitDirectory) {
  const configPath = path.join(gitDirectory, "config");
  let section = "";
  let workTree = null;
  for (const rawLine of fs.readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const sectionLine = stripConfigComment(line).trim();
    const sectionMatch = /^\[([^\]]+)\]$/.exec(sectionLine);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      continue;
    }
    if (section !== "core") {
      continue;
    }
    const valueMatch = /^worktree\s*=\s*(.+)$/i.exec(line);
    if (valueMatch) {
      const value = parseConfigValue(valueMatch[1]);
      workTree = value ? path.resolve(gitDirectory, value) : null;
    }
  }
  return workTree;
}

function configuredWorkTree(gitDirectory) {
  try {
    const workTree = readConfiguredWorkTree(gitDirectory);
    return workTree && fs.statSync(workTree).isDirectory() ? fs.realpathSync.native(workTree) : null;
  } catch {
    return null;
  }
}

function findMarkerWorkspace(canonicalCwd) {
  const cwdStats = fs.statSync(canonicalCwd);
  let current = cwdStats.isFile() ? path.dirname(canonicalCwd) : canonicalCwd;

  while (true) {
    try {
      const gitDirectory = resolveGitDirectory(path.join(current, ".git"));
      if (gitDirectory) {
        return { workspace: fs.realpathSync.native(current), gitDirectory };
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        throw error;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function resolveWorkspaceRoot(cwd, env = process.env) {
  try {
    const canonicalCwd = fs.realpathSync.native(cwd);
    const invocationDirectory = fs.statSync(canonicalCwd).isFile() ? path.dirname(canonicalCwd) : canonicalCwd;
    const marker = findMarkerWorkspace(canonicalCwd);

    if (env?.GIT_DIR) {
      try {
        const gitDirectory = resolveGitDirectory(path.resolve(cwd, env.GIT_DIR));
        if (gitDirectory) {
          const workTree = env.GIT_WORK_TREE
            ? path.resolve(cwd, env.GIT_WORK_TREE)
            : configuredWorkTree(gitDirectory) ?? invocationDirectory;
          if (fs.statSync(workTree).isDirectory()) {
            return fs.realpathSync.native(workTree);
          }
        }
      } catch {
        // Invalid Git environment overrides do not suppress normal marker discovery.
      }
    } else if (env?.GIT_WORK_TREE && marker) {
      try {
        const workTree = path.resolve(cwd, env.GIT_WORK_TREE);
        if (fs.statSync(workTree).isDirectory()) {
          return fs.realpathSync.native(workTree);
        }
      } catch {
        // Invalid Git environment overrides do not suppress normal marker discovery.
      }
    }

    if (marker) {
      return configuredWorkTree(marker.gitDirectory) ?? marker.workspace;
    }
    return cwd;
  } catch {
    return cwd;
  }
}
