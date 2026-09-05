import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { ensureAbsolutePath } from "./fs.mjs";

export const TRANSCRIPT_PATH_ENV = "CODEX_COMPANION_TRANSCRIPT_PATH";
const CLAUDE_CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";

function resolveUserPath(cwd, value) {
  if (value === "~") {
    return os.homedir();
  }
  if (String(value).startsWith("~/")) {
    return path.join(os.homedir(), String(value).slice(2));
  }
  return ensureAbsolutePath(cwd, value);
}

function defaultClaudeProjectsDir() {
  return path.join(os.homedir(), ".claude", "projects");
}

function configuredClaudeProjectsDir(cwd) {
  const configured = process.env[CLAUDE_CONFIG_DIR_ENV];
  return configured ? path.join(resolveUserPath(cwd, configured), "projects") : null;
}

function allowedClaudeProjectsDirs(cwd) {
  return [...new Set([configuredClaudeProjectsDir(cwd), defaultClaudeProjectsDir()].filter(Boolean))];
}

function realpathIfExists(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

function nearestExistingAncestor(value) {
  let current = value;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return fs.realpathSync(current);
}

function fileSha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function filesHaveSameContent(source, candidate, sourceSha256) {
  try {
    if (fs.statSync(source).size !== fs.statSync(candidate).size) return false;
    return fileSha256(candidate) === sourceSha256;
  } catch {
    return false;
  }
}

const STAGING_MARKER_CONTENT = "codex-plugin-cc-staging-v1\n";
const STAGING_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function staleLockCanBeRemoved(lockPath) {
  const ownerPath = path.join(lockPath, "owner");
  try {
    const pid = Number(fs.readFileSync(ownerPath, "utf8"));
    return !(Number.isSafeInteger(pid) && pid > 0 && processIsAlive(pid));
  } catch {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > 1000;
    } catch {
      return true;
    }
  }
}

function copyToExclusiveStagingPath(source, preferredPath) {
  const parsed = path.parse(preferredPath);
  const sourceSha256 = fileSha256(source);
  const stableFallback = path.join(parsed.dir, `${parsed.name}.codex-import-${sourceSha256}${parsed.ext}`);
  for (const candidate of [preferredPath, stableFallback]) {
    try {
      fs.copyFileSync(source, candidate, fs.constants.COPYFILE_EXCL);
      return { path: candidate, created: true, sourceSha256 };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (filesHaveSameContent(source, candidate, sourceSha256)) {
        return { path: candidate, created: false, sourceSha256 };
      }
    }
  }
  throw new Error(`Cannot allocate a stable staging path under ${parsed.dir}`);
}

function withStagingLock(stagedPath, callback) {
  const lockPath = `${stagedPath}.codex-staging-lock`;
  const ownerPath = path.join(lockPath, "owner");
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      fs.mkdirSync(lockPath);
      try {
        fs.writeFileSync(ownerPath, `${process.pid}\n`, { flag: "wx" });
      } catch (error) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (staleLockCanBeRemoved(lockPath)) {
        try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring staging lock for ${stagedPath}`);
      Atomics.wait(STAGING_LOCK_WAIT, 0, 0, 5);
    }
  }
  try { return callback(); } finally { fs.rmSync(lockPath, { recursive: true, force: true }); }
}

function managedMarkerMatches(markerPath) {
  try { return fs.readFileSync(markerPath, "utf8") === STAGING_MARKER_CONTENT; } catch { return false; }
}

function acquireStagingLease(stagedPath, staged) {
  const directory = path.dirname(stagedPath);
  const base = path.basename(stagedPath);
  const markerPath = `${stagedPath}.codex-staging-managed`;
  const leasePrefix = `${base}.codex-staging-lease-`;
  const leasePath = path.join(directory, `${leasePrefix}${process.pid}-${randomUUID()}`);
  let managed = false;

  withStagingLock(stagedPath, () => {
    const markerMatches = managedMarkerMatches(markerPath);
    if (staged.created) {
      if (fs.existsSync(markerPath) && !markerMatches) {
        throw new Error(`Refusing to manage unknown staging marker: ${markerPath}`);
      }
      if (!markerMatches) fs.writeFileSync(markerPath, STAGING_MARKER_CONTENT, { flag: "wx" });
      managed = true;
    } else {
      managed = markerMatches;
    }
    if (managed) fs.writeFileSync(leasePath, "", { flag: "wx" });
  });

  return {
    release() {
      if (!managed) return;
      withStagingLock(stagedPath, () => {
        try { fs.unlinkSync(leasePath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
        const activeLeases = fs.readdirSync(directory).filter((name) => name.startsWith(leasePrefix));
        if (activeLeases.length > 0 || !managedMarkerMatches(markerPath)) return;
        if (fs.existsSync(stagedPath) && fileSha256(stagedPath) !== staged.sourceSha256) {
          fs.unlinkSync(markerPath);
          return;
        }
        try { fs.unlinkSync(stagedPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
        try { fs.unlinkSync(markerPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      });
    }
  };
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function findContainingProjectsRoot(cwd, source) {
  for (const configuredPath of allowedClaudeProjectsDirs(cwd)) {
    const realRoot = realpathIfExists(configuredPath);
    if (realRoot && isWithin(realRoot, source)) {
      return { configuredPath, realRoot };
    }
  }
  return null;
}

export function resolveClaudeSessionPath(cwd, options = {}) {
  const requestedPath = options.source || process.env[TRANSCRIPT_PATH_ENV];
  if (!requestedPath) {
    throw new Error("Could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>.");
  }

  const sourcePath = resolveUserPath(cwd, requestedPath);
  if (path.extname(sourcePath) !== ".jsonl") {
    throw new Error(`Claude session source must be a JSONL file: ${sourcePath}`);
  }

  let source;
  try {
    source = fs.realpathSync(sourcePath);
  } catch {
    throw new Error(`Claude session file not found: ${sourcePath}`);
  }

  if (!findContainingProjectsRoot(cwd, source)) {
    throw new Error(
      `Codex can import Claude sessions only from ${allowedClaudeProjectsDirs(cwd).join(" or ")}: ${source}`
    );
  }
  return source;
}

export function prepareClaudeSessionImport(cwd, sourcePath) {
  const source = fs.realpathSync(sourcePath);
  const defaultProjects = defaultClaudeProjectsDir();
  const defaultRoot = realpathIfExists(defaultProjects);
  if (defaultRoot && isWithin(defaultRoot, source)) {
    return { sourcePath: source, importPath: source, staged: false, cleanup() {} };
  }

  const sourceRoot = findContainingProjectsRoot(cwd, source);
  if (!sourceRoot) {
    throw new Error(`Claude session is outside the configured projects roots: ${source}`);
  }

  const relative = path.relative(sourceRoot.realRoot, source);
  const importPath = path.join(defaultProjects, relative);
  fs.mkdirSync(defaultProjects, { recursive: true });

  const canonicalDefaultRoot = fs.realpathSync(defaultProjects);
  const importParent = path.dirname(importPath);
  const canonicalExistingAncestor = nearestExistingAncestor(importParent);
  if (!canonicalExistingAncestor || (canonicalExistingAncestor !== canonicalDefaultRoot && !isWithin(canonicalDefaultRoot, canonicalExistingAncestor))) {
    throw new Error(`Cannot stage Claude session outside the default Claude projects root: ${canonicalExistingAncestor ?? importParent}`);
  }

  fs.mkdirSync(importParent, { recursive: true });
  const canonicalImportParent = fs.realpathSync(importParent);
  if (canonicalImportParent !== canonicalDefaultRoot && !isWithin(canonicalDefaultRoot, canonicalImportParent)) {
    throw new Error(`Cannot stage Claude session outside the default Claude projects root: ${canonicalImportParent}`);
  }

  const staged = copyToExclusiveStagingPath(source, importPath);
  const canonicalImportPath = fs.realpathSync(staged.path);
  if (!isWithin(canonicalDefaultRoot, canonicalImportPath)) {
    if (staged.created) fs.unlinkSync(canonicalImportPath);
    throw new Error(`Cannot stage Claude session outside the default Claude projects root: ${canonicalImportPath}`);
  }
  const lease = acquireStagingLease(canonicalImportPath, staged);
  return {
    sourcePath: source,
    importPath: canonicalImportPath,
    staged: true,
    cleanup() {
      lease.release();
    }
  };
}
