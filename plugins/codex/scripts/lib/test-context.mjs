import fs from "node:fs";
import path from "node:path";

import { collectReviewContext, getRepoRoot, resolveReviewTarget } from "./git.mjs";

const GUIDANCE_PREFERENCE = ["claude.md", "agents.md", "readme.md"];
const GUIDANCE_LIMIT_BYTES = 24 * 1024;
const GUIDANCE_TOTAL_LIMIT_BYTES = 48 * 1024;
const GUIDANCE_MAX_FILES = 6;
const MAX_GUIDANCE_DEPTH = 3;
const TEST_COMMAND_LIMIT = 6;
const WALK_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  "coverage"
]);
const TEST_DIR_NAMES = new Set(["test", "tests", "__tests__"]);
const SOURCE_ROOT_NAMES = new Set(["src", "lib", "app", "server", "backend", "frontend", "cmd", "internal"]);
const TEST_COMMAND_PATTERNS = [
  /\b(?:make|just)\s+(?:test|test-ci|test-local|check|verify)\b/gi,
  /\b(?:npm|pnpm|yarn)\s+test\b/gi,
  /\b(?:uv\s+run\s+)?pytest(?:\s+[^\n`]+)?/gi,
  /\bnode\s+--test(?:\s+[^\n`]+)?/gi,
  /\bgo\s+test(?:\s+[^\n`]+)?/gi
];

function isPathWithinRoot(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasNestedGitCheckout(absoluteDir) {
  return fs.existsSync(path.join(absoluteDir, ".git"));
}

function walkRepoFiles(rootDir, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : Number.POSITIVE_INFINITY;
  const results = [];
  const queue = [{ absoluteDir: rootDir, relativeDir: "", depth: 0 }];
  const visitedDirectories = new Set();
  let rootRealPath;

  try {
    rootRealPath = fs.realpathSync.native(rootDir);
  } catch {
    rootRealPath = rootDir;
  }
  visitedDirectories.add(rootRealPath);

  while (queue.length > 0) {
    const current = queue.shift();
    const entries = fs.readdirSync(current.absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(current.absoluteDir, entry.name);
      const relativePath = current.relativeDir ? path.posix.join(current.relativeDir, entry.name) : entry.name;
      const normalizedName = entry.name.toLowerCase();
      if (entry.isDirectory()) {
        if (WALK_SKIP_DIRS.has(normalizedName) || current.depth >= maxDepth) {
          continue;
        }
        if (hasNestedGitCheckout(absolutePath)) {
          continue;
        }
        let directoryKey;
        try {
          directoryKey = fs.realpathSync.native(absolutePath);
        } catch {
          directoryKey = absolutePath;
        }
        if (visitedDirectories.has(directoryKey)) {
          continue;
        }
        visitedDirectories.add(directoryKey);
        queue.push({
          absoluteDir: absolutePath,
          relativeDir: relativePath,
          depth: current.depth + 1
        });
        continue;
      }
      if (entry.isSymbolicLink()) {
        let realPath;
        let stat;
        try {
          realPath = fs.realpathSync.native(absolutePath);
          stat = fs.statSync(absolutePath);
        } catch {
          continue;
        }
        if (!isPathWithinRoot(rootRealPath, realPath)) {
          continue;
        }
        if (stat.isFile()) {
          results.push(relativePath);
        }
        // Skip symlinked directories for now: following them can escape repoRoot
        // and pull unrelated files into /codex:test. If we need this later,
        // constrain traversal to realpaths that still stay under repoRoot.
        continue;
      }
      if (entry.isFile()) {
        results.push(relativePath);
      }
    }
  }

  return results.sort();
}

function readTrimmedFile(repoRoot, relativePath, maxBytes = GUIDANCE_LIMIT_BYTES) {
  const absolutePath = path.join(repoRoot, relativePath);
  const buffer = fs.readFileSync(absolutePath);
  if (buffer.length <= maxBytes) {
    return buffer.toString("utf8").trim();
  }
  return `${buffer.subarray(0, maxBytes).toString("utf8").trim()}\n...[truncated]`;
}

function guidanceSortKey(relativePath) {
  const baseName = path.basename(relativePath).toLowerCase();
  const preferenceIndex = GUIDANCE_PREFERENCE.indexOf(baseName);
  const depth = relativePath.split("/").length - 1;
  return [preferenceIndex === -1 ? GUIDANCE_PREFERENCE.length : preferenceIndex, depth, relativePath];
}

function collectGuidanceFiles(repoRoot) {
  const repoFiles = walkRepoFiles(repoRoot, { maxDepth: MAX_GUIDANCE_DEPTH });
  const matches = repoFiles
    .filter((relativePath) => GUIDANCE_PREFERENCE.includes(path.basename(relativePath).toLowerCase()))
    .sort((left, right) => {
      const [leftIndex, leftDepth, leftPath] = guidanceSortKey(left);
      const [rightIndex, rightDepth, rightPath] = guidanceSortKey(right);
      return leftIndex - rightIndex || leftDepth - rightDepth || leftPath.localeCompare(rightPath);
    });
  const guidanceFiles = [];
  let totalBytes = 0;
  for (const relativePath of matches) {
    if (guidanceFiles.length >= GUIDANCE_MAX_FILES) {
      break;
    }
    const content = readTrimmedFile(repoRoot, relativePath);
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (guidanceFiles.length > 0 && totalBytes + contentBytes > GUIDANCE_TOTAL_LIMIT_BYTES) {
      continue;
    }
    guidanceFiles.push({
      path: relativePath,
      content
    });
    totalBytes += contentBytes;
  }

  return guidanceFiles;
}

function isTestFile(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  const baseName = path.basename(normalized).toLowerCase();
  const parts = normalized.split("/");
  const matchesTestName =
    baseName.includes(".test.") ||
    baseName.includes(".spec.") ||
    baseName.startsWith("test_") ||
    baseName.endsWith("_test.go");
  if (matchesTestName) {
    return true;
  }
  return parts.some((part) => TEST_DIR_NAMES.has(part.toLowerCase())) && matchesTestName;
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function detectPrimaryTestLocations(testFiles) {
  return uniqueSorted(
    testFiles.map((relativePath) => {
      const parts = relativePath.replace(/\\/g, "/").split("/");
      const testDirIndex = parts.findIndex((part) => TEST_DIR_NAMES.has(part.toLowerCase()));
      if (testDirIndex >= 0) {
        return parts.slice(0, testDirIndex + 1).join("/");
      }
      return path.posix.dirname(relativePath);
    })
  );
}

function extnamePreservingDeclaration(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.endsWith(".d.ts")) {
    return ".ts";
  }
  return path.extname(normalized);
}

function fileStem(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  const baseName = path.basename(normalized);
  if (baseName.endsWith(".d.ts")) {
    return baseName.slice(0, -5);
  }
  const extension = path.extname(baseName);
  return extension ? baseName.slice(0, -extension.length) : baseName;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferPreferredJavascriptTestExtension(testFiles, options = {}) {
  const scopeRoots = Array.isArray(options.scopeRoots) ? options.scopeRoots.filter(Boolean) : [];
  const scopedFiles =
    scopeRoots.length === 0
      ? testFiles
      : testFiles.filter((file) => scopeRoots.some((root) => file === root || file.startsWith(`${root}/`)));
  const counts = new Map();
  for (const file of scopedFiles) {
    const baseName = path.basename(file).toLowerCase();
    if (!baseName.includes(".test.") && !baseName.includes(".spec.")) {
      continue;
    }
    const extension = path.extname(baseName) || ".js";
    counts.set(extension, (counts.get(extension) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  return ranked[0]?.[0] ?? ".js";
}

function longestSharedPrefixLength(left, right) {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function getPrimaryLocationScopeParts(location) {
  const normalized = location.replace(/\\/g, "/");
  if (normalized === ".") {
    return [];
  }
  const parts = normalized.split("/").filter((part) => part !== ".");
  const testDirIndex = parts.findIndex((part) => TEST_DIR_NAMES.has(part.toLowerCase()));
  if (testDirIndex >= 0) {
    return parts.slice(0, testDirIndex);
  }
  // For nonstandard test roots like "spec/" (or "packages/a/spec"), the
  // location itself is the test root, so scope matching should use its parent.
  return parts.slice(0, -1);
}

function isExplicitTestDirectoryLocation(location) {
  const normalized = location.replace(/\\/g, "/");
  if (normalized === ".") {
    return false;
  }
  return normalized.split("/").some((part) => TEST_DIR_NAMES.has(part.toLowerCase()));
}

function rankPrimaryLocationsForSource(relativePath, primaryLocations) {
  const normalized = relativePath.replace(/\\/g, "/");
  const sourceDir = path.posix.dirname(normalized);
  const sourceDirParts = sourceDir === "." ? [] : sourceDir.split("/");
  const ranked = primaryLocations
    .map((location) => {
      const scopeParts = getPrimaryLocationScopeParts(location);
      const sharedPrefixLength = longestSharedPrefixLength(scopeParts, sourceDirParts);
      const scopeMatchesSource =
        scopeParts.length <= sourceDirParts.length && scopeParts.every((part, index) => sourceDirParts[index] === part);
      return {
        location,
        scopeParts,
        sharedPrefixLength,
        scopeMatchesSource,
        explicitTestDirectory: isExplicitTestDirectoryLocation(location)
      };
    })
    .sort((left, right) => {
      return (
        Number(right.scopeMatchesSource) - Number(left.scopeMatchesSource) ||
        right.sharedPrefixLength - left.sharedPrefixLength ||
        Number(right.explicitTestDirectory) - Number(left.explicitTestDirectory) ||
        right.scopeParts.length - left.scopeParts.length ||
        left.location.localeCompare(right.location)
      );
    });
  if (ranked.length === 0) {
    return [];
  }
  const best = ranked[0];
  if (!best.scopeMatchesSource) {
    return [];
  }
  return ranked
    .filter(
      (location) =>
        location.scopeMatchesSource === best.scopeMatchesSource &&
        location.sharedPrefixLength === best.sharedPrefixLength &&
        location.explicitTestDirectory === best.explicitTestDirectory &&
        location.scopeParts.length === best.scopeParts.length
    )
    .map((location) => location.location);
}

function relativeDirWithinSelectedTestRoot(relativePath, preferredRoot) {
  const normalized = relativePath.replace(/\\/g, "/");
  const dirName = path.posix.dirname(normalized);
  if (dirName === ".") {
    return [];
  }
  const dirParts = dirName.split("/");
  const scopeParts = preferredRoot ? getPrimaryLocationScopeParts(preferredRoot) : [];
  const relativeToScope =
    scopeParts.length > 0 && scopeParts.every((part, index) => dirParts[index] === part) ? dirParts.slice(scopeParts.length) : dirParts;
  const sourceRootIndex = relativeToScope.findIndex((part) => SOURCE_ROOT_NAMES.has(part.toLowerCase()));
  if (sourceRootIndex >= 0) {
    return relativeToScope.slice(sourceRootIndex + 1);
  }
  return relativeToScope;
}

function buildTestFileCandidates(relativePath, testFiles, primaryLocations) {
  const normalized = relativePath.replace(/\\/g, "/");
  const baseName = path.basename(normalized).toLowerCase();
  const stem = fileStem(normalized);
  const loweredStem = stem.toLowerCase();
  const extension = extnamePreservingDeclaration(normalized).toLowerCase();
  const exactJavascriptTestPattern = new RegExp(`^${escapeRegExp(loweredStem)}\\.(?:test|spec)\\.`);
  // In monorepos, keep both direct matches and new test targets inside the
  // nearest package-local test root so /codex:test does not spill across packages.
  const rankedPrimaryLocations = rankPrimaryLocationsForSource(normalized, primaryLocations);
  const preferredRoots = new Set(rankedPrimaryLocations);

  const directMatches = testFiles.filter((candidate) => {
    const candidateBaseName = path.basename(candidate).toLowerCase();
    if (candidateBaseName === baseName) {
      return true;
    }
    if (exactJavascriptTestPattern.test(candidateBaseName)) {
      return true;
    }
    if (candidateBaseName === `test_${loweredStem}.py`) {
      return true;
    }
    if (candidateBaseName === `${loweredStem}_test.go`) {
      return true;
    }
    return false;
  });
  if (directMatches.length > 0) {
    if (preferredRoots.size === 0) {
      return [];
    }
    const scopedMatches = directMatches.filter((candidate) =>
      [...preferredRoots].some((root) => candidate === root || candidate.startsWith(`${root}/`))
    );
    if (scopedMatches.length === 0) {
      return [];
    }
    return uniqueSorted(scopedMatches).map((candidate) => ({ path: candidate, action: "update" }));
  }

  if (extension === ".go") {
    const dirName = path.posix.dirname(normalized);
    return [{ path: path.posix.join(dirName, `${stem}_test.go`), action: "create" }];
  }

  if (extension === ".py") {
    const preferredRoot = rankedPrimaryLocations[0];
    if (!preferredRoot) {
      return [];
    }
    const strippedParts = relativeDirWithinSelectedTestRoot(normalized, preferredRoot);
    return [{ path: path.posix.join(preferredRoot, ...strippedParts, `test_${stem}.py`), action: "create" }];
  }

  if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(extension)) {
    const preferredRoot = rankedPrimaryLocations[0];
    if (!preferredRoot) {
      return [];
    }
    const preferredExtension = inferPreferredJavascriptTestExtension(testFiles, { scopeRoots: [preferredRoot] }) || extension || ".js";
    const strippedParts = relativeDirWithinSelectedTestRoot(normalized, preferredRoot);
    const candidateDir = path.posix.join(preferredRoot, ...strippedParts);
    return [{ path: path.posix.join(candidateDir, `${stem}.test${preferredExtension}`), action: "create" }];
  }

  return [];
}

function inferTestPlan(repoRoot, changedFiles, testFiles, primaryLocations) {
  const entries = [];
  for (const relativePath of changedFiles) {
    if (!fs.existsSync(path.join(repoRoot, relativePath))) {
      continue;
    }
    if (isTestFile(relativePath)) {
      entries.push({
        sourcePath: relativePath,
        targets: [{ path: relativePath, action: "update" }]
      });
      continue;
    }
    const targets = buildTestFileCandidates(relativePath, testFiles, primaryLocations);
    if (targets.length === 0) {
      continue;
    }
    entries.push({
      sourcePath: relativePath,
      targets
    });
  }

  return entries;
}

function formatGuidanceSection(guidanceFiles) {
  return guidanceFiles
    .map(
      (file) => [
        `### ${file.path}`,
        "```md",
        file.content || "(empty)",
        "```"
      ].join("\n")
    )
    .join("\n\n");
}

function formatTestLayout(testFiles, primaryLocations) {
  const lines = [
    `Primary test locations: ${primaryLocations.join(", ")}`,
    "",
    "Known test files:"
  ];
  for (const file of testFiles.slice(0, 40)) {
    lines.push(`- ${file}`);
  }
  if (testFiles.length > 40) {
    lines.push(`- ... ${testFiles.length - 40} more`);
  }
  return lines.join("\n");
}

function formatPlannedTestChanges(entries) {
  return entries
    .map((entry) => {
      const lines = [`- ${entry.sourcePath}`];
      for (const target of entry.targets) {
        lines.push(`  - ${target.action}: ${target.path}`);
      }
      return lines.join("\n");
    })
    .join("\n");
}

function extractTestCommandsFromText(text) {
  const matches = [];
  for (const pattern of TEST_COMMAND_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[0].trim().replace(/[.,;:]+$/, "");
      if (candidate) {
        matches.push(candidate);
      }
    }
  }
  return matches;
}

function collectSuggestedTestCommands(repoRoot, guidanceFiles) {
  const candidates = [];
  for (const guidance of guidanceFiles) {
    candidates.push(...extractTestCommandsFromText(guidance.content));
  }

  const makefilePath = path.join(repoRoot, "Makefile");
  if (fs.existsSync(makefilePath)) {
    const makefile = fs.readFileSync(makefilePath, "utf8");
    candidates.push(...extractTestCommandsFromText(makefile));
    if (/^test-ci:/m.test(makefile)) {
      candidates.push("make test-ci");
    }
    if (/^test-local:/m.test(makefile)) {
      candidates.push("make test-local");
    }
    if (/^test:/m.test(makefile)) {
      candidates.push("make test");
    }
  }

  return uniqueSorted(candidates).slice(0, TEST_COMMAND_LIMIT);
}

function formatSuggestedTestCommands(commands) {
  if (commands.length === 0) {
    return "No repository-specific test command could be inferred from the available guidance.";
  }
  return commands.map((command) => `- ${command}`).join("\n");
}

export function collectTestCommandContext(cwd, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const target =
    options.target ??
    resolveReviewTarget(cwd, {
      base: options.base,
      scope: options.scope
    });
  const reviewContext = collectReviewContext(repoRoot, target, options);
  const guidanceFiles = collectGuidanceFiles(repoRoot);
  if (guidanceFiles.length === 0) {
    throw new Error("No project guidance found: expected at least one of CLAUDE.md, AGENTS.md, README.md.");
  }

  const repoFiles = walkRepoFiles(repoRoot);
  const testFiles = repoFiles.filter((relativePath) => isTestFile(relativePath));
  const primaryLocations = detectPrimaryTestLocations(testFiles);
  if (primaryLocations.length === 0) {
    throw new Error("No test layout detected for this repository.");
  }

  const productionFiles = reviewContext.changedFiles.filter((relativePath) => !isTestFile(relativePath));
  const testPlanEntries = inferTestPlan(repoRoot, productionFiles, testFiles, primaryLocations);
  if (testPlanEntries.length === 0) {
    throw new Error("Unable to infer test targets from changed files.");
  }
  const suggestedTestCommands = collectSuggestedTestCommands(repoRoot, guidanceFiles);

  return {
    repoRoot,
    target,
    reviewContext,
    guidanceFiles,
    productionFiles,
    testFiles,
    primaryLocations,
    testPlanEntries,
    suggestedTestCommands,
    renderedGuidance: formatGuidanceSection(guidanceFiles),
    renderedTestLayout: formatTestLayout(testFiles, primaryLocations),
    renderedPlan: formatPlannedTestChanges(testPlanEntries),
    renderedSuggestedCommands: formatSuggestedTestCommands(suggestedTestCommands)
  };
}
