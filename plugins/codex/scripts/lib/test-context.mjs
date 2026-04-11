import fs from "node:fs";
import path from "node:path";

import { collectReviewContext, getRepoRoot, resolveReviewTarget } from "./git.mjs";

const GUIDANCE_PREFERENCE = ["claude.md", "agents.md", "readme.md"];
const GUIDANCE_LIMIT_BYTES = 24 * 1024;
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
  return [preferenceIndex === -1 ? GUIDANCE_PREFERENCE.length : preferenceIndex, relativePath];
}

function collectGuidanceFiles(repoRoot) {
  const repoFiles = walkRepoFiles(repoRoot, { maxDepth: MAX_GUIDANCE_DEPTH });
  const matches = repoFiles
    .filter((relativePath) => GUIDANCE_PREFERENCE.includes(path.basename(relativePath).toLowerCase()))
    .sort((left, right) => {
      const [leftIndex, leftPath] = guidanceSortKey(left);
      const [rightIndex, rightPath] = guidanceSortKey(right);
      return leftIndex - rightIndex || leftPath.localeCompare(rightPath);
    });

  return matches.map((relativePath) => ({
    path: relativePath,
    content: readTrimmedFile(repoRoot, relativePath)
  }));
}

function isTestFile(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  const baseName = path.basename(normalized).toLowerCase();
  const parts = normalized.split("/");
  if (parts.some((part) => TEST_DIR_NAMES.has(part.toLowerCase()))) {
    return true;
  }
  return (
    baseName.includes(".test.") ||
    baseName.includes(".spec.") ||
    baseName.startsWith("test_") ||
    baseName.endsWith("_test.go")
  );
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

function inferPreferredJavascriptTestExtension(testFiles) {
  const counts = new Map();
  for (const file of testFiles) {
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

function buildTestFileCandidates(relativePath, testFiles, primaryLocations) {
  const normalized = relativePath.replace(/\\/g, "/");
  const baseName = path.basename(normalized).toLowerCase();
  const stem = fileStem(normalized);
  const loweredStem = stem.toLowerCase();
  const extension = extnamePreservingDeclaration(normalized).toLowerCase();
  const dirName = path.posix.dirname(normalized);
  const exactJavascriptTestPattern = new RegExp(`^${escapeRegExp(loweredStem)}\\.(?:test|spec)\\.`);

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
    return uniqueSorted(directMatches).map((candidate) => ({ path: candidate, action: "update" }));
  }

  if (extension === ".go") {
    return [{ path: path.posix.join(dirName, `${stem}_test.go`), action: "create" }];
  }

  if (extension === ".py") {
    const preferredRoot = primaryLocations.find((location) => TEST_DIR_NAMES.has(path.posix.basename(location).toLowerCase()));
    if (!preferredRoot) {
      return [];
    }
    return [{ path: path.posix.join(preferredRoot, `test_${stem}.py`), action: "create" }];
  }

  if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(extension)) {
    const preferredRoot =
      primaryLocations.find((location) => TEST_DIR_NAMES.has(path.posix.basename(location).toLowerCase())) ??
      primaryLocations[0];
    if (!preferredRoot) {
      return [];
    }
    const preferredExtension = inferPreferredJavascriptTestExtension(testFiles) || extension || ".js";
    const relativeParts = normalized.split("/");
    const withoutFile = relativeParts.slice(0, -1);
    const strippedParts = SOURCE_ROOT_NAMES.has(withoutFile[0]?.toLowerCase()) ? withoutFile.slice(1) : withoutFile;
    const candidateDir = path.posix.join(preferredRoot, ...strippedParts);
    return [{ path: path.posix.join(candidateDir, `${stem}.test${preferredExtension}`), action: "create" }];
  }

  return [];
}

function inferTestPlan(changedFiles, testFiles, primaryLocations) {
  const entries = [];
  for (const relativePath of changedFiles) {
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
  const testPlanEntries = inferTestPlan(productionFiles, testFiles, primaryLocations);
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
