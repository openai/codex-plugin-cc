import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_ROOT = path.resolve(LIB_DIR, "..", "..");
const TEMPLATE_DIR = path.join(LIB_DIR, "agent-templates");
const MARKER_READ_BYTES = 256;

export const REVIEW_SUBAGENT_PROVENANCE_MARKER = "# codex-review-subagent: managed-by-codex-companion";

const REVIEW_SUBAGENTS = [
  {
    command: "review",
    fileName: "codex-review.md"
  },
  {
    command: "adversarial-review",
    fileName: "codex-adversarial-review.md"
  }
];

export function getReviewSubagentTargets(pluginRoot = DEFAULT_PLUGIN_ROOT) {
  const resolvedPluginRoot = path.resolve(pluginRoot);
  return REVIEW_SUBAGENTS.map((agent) => ({
    ...agent,
    templatePath: path.join(TEMPLATE_DIR, agent.fileName),
    targetPath: path.join(resolvedPluginRoot, "agents", agent.fileName)
  }));
}

function isMissingFile(error) {
  return error?.code === "ENOENT";
}

function readFilePrefix(filePath) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(filePath, flags);
  try {
    const buffer = Buffer.alloc(MARKER_READ_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function assertManagedTemplate(templatePath, content) {
  if (!content.slice(0, MARKER_READ_BYTES).includes(REVIEW_SUBAGENT_PROVENANCE_MARKER)) {
    throw new Error(`Template ${templatePath} is missing the Codex review subagent provenance marker.`);
  }
}

function realpath(filePath) {
  return (fs.realpathSync.native ?? fs.realpathSync)(filePath);
}

function isPathContained(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function inodeSnapshot(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino
  };
}

function sameInodeSnapshot(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertContainedAgentsDir(pluginRoot, options = {}) {
  const resolvedPluginRoot = path.resolve(pluginRoot);
  const agentsDir = path.join(resolvedPluginRoot, "agents");
  const pluginRootReal = realpath(resolvedPluginRoot);
  let stat;

  try {
    stat = fs.lstatSync(agentsDir);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
    if (!options.create) {
      return null;
    }
    fs.mkdirSync(agentsDir, { recursive: true });
    stat = fs.lstatSync(agentsDir);
  }

  if (stat.isSymbolicLink()) {
    try {
      const agentsReal = realpath(agentsDir);
      if (!isPathContained(pluginRootReal, agentsReal)) {
        throw new Error(`Refusing to use ${agentsDir}: agents directory resolves outside the plugin root.`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("resolves outside")) {
        throw error;
      }
    }
    throw new Error(`Refusing to use ${agentsDir}: agents directory is a symbolic link.`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Refusing to use ${agentsDir}: agents path is not a directory.`);
  }

  const agentsReal = realpath(agentsDir);
  if (!isPathContained(pluginRootReal, agentsReal)) {
    throw new Error(`Refusing to use ${agentsDir}: agents directory resolves outside the plugin root.`);
  }

  return { agentsDir, agentsReal, pluginRootReal, snapshot: inodeSnapshot(stat) };
}

function assertAgentsDirIdentity(pluginRoot, expected, action, targetPath) {
  const current = assertContainedAgentsDir(pluginRoot);
  if (!current || !sameInodeSnapshot(current.snapshot, expected.snapshot)) {
    throw new Error(`Refusing to ${action} ${targetPath}: agents directory identity changed during materialization.`);
  }
  return current;
}

function assertManagedRegularTarget(targetPath, action) {
  let stat;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to ${action} ${targetPath}: path is a symbolic link.`);
  }
  if (!stat.isFile()) {
    throw new Error(`Refusing to ${action} ${targetPath}: path is not a regular file.`);
  }
  if (!readFilePrefix(targetPath).includes(REVIEW_SUBAGENT_PROVENANCE_MARKER)) {
    throw new Error(
      `Refusing to ${action} ${targetPath}: existing file is not a Codex-managed review subagent. Remove it manually to continue.`
    );
  }

  return stat;
}

function sameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function fsyncDirectory(dirPath) {
  let fd = null;
  try {
    fd = fs.openSync(dirPath, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch {
    // Some platforms do not allow directory fsync; the file-level fsync still ran.
  } finally {
    if (fd != null) {
      fs.closeSync(fd);
    }
  }
}

/**
 * Writes through a sibling temp file and a final path-based rename. Node.js does
 * not expose openat/renameat, so a process that already has write access to the
 * agents directory can still race the last path lookup in a tiny TOCTOU window.
 * The directory and inode snapshots below are defense-in-depth checks, not a
 * full substitute for fd-relative syscalls.
 */
function atomicWriteFile(pluginRoot, targetPath, content) {
  const agentsDir = assertContainedAgentsDir(pluginRoot);
  const dirPath = path.dirname(targetPath);
  const tempPath = path.join(
    dirPath,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  let fd = null;

  try {
    fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    const tempSnapshot = inodeSnapshot(fs.lstatSync(tempPath));

    assertManagedRegularTarget(targetPath, "overwrite");
    assertAgentsDirIdentity(pluginRoot, agentsDir, "overwrite", targetPath);
    fs.renameSync(tempPath, targetPath);
    if (!sameInodeSnapshot(inodeSnapshot(fs.lstatSync(targetPath)), tempSnapshot)) {
      throw new Error(`Refusing to publish ${targetPath}: post-rename inode mismatch.`);
    }
    fsyncDirectory(dirPath);
  } catch (error) {
    if (fd != null) {
      fs.closeSync(fd);
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup for an incomplete temp file.
    }
    throw error;
  }
}

export function materializeReviewSubagents(pluginRoot = DEFAULT_PLUGIN_ROOT) {
  assertContainedAgentsDir(pluginRoot, { create: true });
  const targets = getReviewSubagentTargets(pluginRoot);
  const writes = targets.map((target) => {
    const content = fs.readFileSync(target.templatePath, "utf8");
    assertManagedTemplate(target.templatePath, content);
    assertManagedRegularTarget(target.targetPath, "overwrite");
    return { ...target, content };
  });

  for (const target of writes) {
    atomicWriteFile(pluginRoot, target.targetPath, target.content);
  }

  return targets;
}

export function areReviewSubagentsMaterialized(pluginRoot = DEFAULT_PLUGIN_ROOT) {
  try {
    for (const target of getReviewSubagentTargets(pluginRoot)) {
      if (!assertManagedRegularTarget(target.targetPath, "inspect")) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes only provenance-marked generated agents. The final unlink is
 * necessarily path-based because Node.js does not expose openat/unlinkat. A
 * process that already has write access to the agents directory can still race
 * the last path lookup in a tiny TOCTOU window; the parent directory and target
 * snapshots below mitigate that risk but cannot eliminate it without native
 * fd-relative syscalls.
 */
export function removeReviewSubagents(pluginRoot = DEFAULT_PLUGIN_ROOT) {
  const agentsDir = assertContainedAgentsDir(pluginRoot);
  if (!agentsDir) {
    return getReviewSubagentTargets(pluginRoot);
  }
  const targets = getReviewSubagentTargets(pluginRoot);
  const removals = [];

  for (const target of targets) {
    const stat = assertManagedRegularTarget(target.targetPath, "remove");
    if (stat) {
      removals.push({ ...target, stat });
    }
  }

  for (const target of removals) {
    const current = assertManagedRegularTarget(target.targetPath, "remove");
    if (!current) {
      continue;
    }
    if (!sameFileSnapshot(current, target.stat)) {
      throw new Error(`Refusing to remove ${target.targetPath}: file changed during review subagent cleanup.`);
    }
    assertAgentsDirIdentity(pluginRoot, agentsDir, "remove", target.targetPath);
    fs.unlinkSync(target.targetPath);
  }

  return targets;
}
