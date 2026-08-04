import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { runCommandChecked } from "./process.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./prompts.mjs";

export const PARALLEL_GATE_MIN_LINES = 300;
export const PARALLEL_GATE_MIN_FILES = 8;
export const DEFAULT_MAX_SHARDS = 4;
export const REDUCE_VERDICTS = new Set(["CONFIRMED", "SUSPECTED", "REJECTED"]);

const TARGET_LINES_PER_SHARD = 400;
const OVERSIZE_UNIT_RATIO = 1.25;
const BINARY_FILE_WEIGHT = 20;
const MAX_SHARD_DIFF_BYTES = 150_000;
// Same bound lib/git.mjs uses for untracked content: stat before reading so a
// giant generated artifact can never stall or OOM the orchestrator.
const MAX_UNTRACKED_READ_BYTES = 24 * 1024;
const MAX_SEAM_HINTS = 100;
const MAX_SEAM_READ_BYTES = 1_000_000;
const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".scss"]);
const STYLE_EXTENSIONS = new Set([".css", ".scss"]);
const IMPORT_RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".css", "/index.ts", "/index.tsx", "/index.js"];

// Metadata reads (numstat/name-status) can be large on a big diff, so lift the
// default buffer well above spawnSync's 1MB; per-file diff reads pass a tight
// bound so an oversized single-file diff is caught instead of read whole.
const GIT_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;

// Git is directly executable on Windows. Repository-derived arguments must never pass through a shell.
function runGit(cwd, args, options = {}) {
  return runCommandChecked("git", args, {
    cwd,
    shell: false,
    maxBuffer: options.maxBuffer ?? GIT_OUTPUT_MAX_BUFFER
  }).stdout;
}

// Working-tree reviews must read HEAD→index (staged) and index→worktree
// (unstaged) as separate legs: a staged edit whose worktree copy reverts it
// is invisible to a single `git diff HEAD`.
function diffArgSets(target) {
  return target.mode === "branch" ? [[`${target.baseRef}...HEAD`]] : [["--cached"], []];
}

function gitShowOrNull(cwd, ref) {
  try {
    return runGit(cwd, ["show", ref], { maxBuffer: MAX_SEAM_READ_BYTES + 1 });
  } catch {
    // The path is absent from that snapshot (untracked, unstaged-only, deleted)
    // or larger than the seam-scan bound; the caller falls back or skips it.
    return null;
  }
}

// Seam hints must reflect the snapshot under review, not whatever the worktree
// happens to hold. A branch review is HEAD (the worktree may carry unrelated
// uncommitted edits); a working-tree review covers both the staged and unstaged
// legs, so scan the staged blob and the worktree file together — a seam
// introduced in either leg (including a staged change whose worktree copy was
// reverted) is then still seen. Returns null when nothing readable exists.
export function readReviewedFileContent(cwd, target, relativePath) {
  if (target.mode === "branch") {
    return gitShowOrNull(cwd, `HEAD:${relativePath}`);
  }

  const parts = [];
  const staged = gitShowOrNull(cwd, `:${relativePath}`);
  if (staged != null) {
    parts.push(staged);
  }
  try {
    const absolute = path.join(cwd, relativePath);
    if (fs.statSync(absolute).size <= MAX_SEAM_READ_BYTES) {
      parts.push(fs.readFileSync(absolute, "utf8"));
    }
  } catch {
    // Untracked or deleted in the worktree; a staged copy (if any) still scanned.
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

// `--numstat -M` renders renames as either `old => new` or `pre{old => new}post`.
export function normalizeRenamePath(rawPath) {
  if (rawPath.includes("{")) {
    return rawPath
      .replace(/\{([^{}]*) => ([^{}]*)\}/g, (_, _from, to) => to)
      .replace(/\/{2,}/g, "/")
      .replace(/^\.\//, "");
  }
  if (rawPath.includes(" => ")) {
    return rawPath.split(" => ").pop();
  }
  return rawPath;
}

export function collectChangedFiles(cwd, target) {
  const argSets = diffArgSets(target);

  // The staged leg runs first, so a path staged as a rename/add keeps that
  // status even when an unstaged edit also touches it.
  const statusByPath = new Map();
  for (const argSet of argSets) {
    for (const line of runGit(cwd, ["diff", "--name-status", "-M", ...argSet]).split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const parts = line.split("\t");
      const code = parts[0];
      const filePath = code.startsWith("R") || code.startsWith("C") ? parts[2] : parts[1];
      if (!statusByPath.has(filePath)) {
        statusByPath.set(filePath, {
          code: code[0],
          oldPath: code.startsWith("R") || code.startsWith("C") ? parts[1] : null
        });
      }
    }
  }

  const churnByPath = new Map();
  for (const argSet of argSets) {
    for (const line of runGit(cwd, ["diff", "--numstat", "-M", ...argSet]).split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const [added, deleted, ...rest] = line.split("\t");
      const filePath = normalizeRenamePath(rest.join("\t"));
      const binary = added === "-" || deleted === "-";
      const legWeight = binary ? BINARY_FILE_WEIGHT : Number.parseInt(added, 10) + Number.parseInt(deleted, 10);
      const entry = churnByPath.get(filePath) ?? { weight: 0, binary: false };
      entry.weight += Number.isFinite(legWeight) ? legWeight : BINARY_FILE_WEIGHT;
      entry.binary = entry.binary || binary;
      churnByPath.set(filePath, entry);
    }
  }

  const files = [];
  for (const [filePath, churn] of churnByPath) {
    const status = statusByPath.get(filePath) ?? { code: "M", oldPath: null };
    files.push({
      path: filePath,
      weight: churn.weight,
      binary: churn.binary,
      status: status.code,
      oldPath: status.oldPath
    });
  }

  if (target.mode !== "branch") {
    for (const filePath of runGit(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n")) {
      if (!filePath.trim()) {
        continue;
      }
      let weight = BINARY_FILE_WEIGHT;
      let binary = false;
      try {
        const absolute = path.join(cwd, filePath);
        if (fs.statSync(absolute).size <= MAX_UNTRACKED_READ_BYTES) {
          const content = fs.readFileSync(absolute);
          if (isProbablyText(content)) {
            weight = content.toString("utf8").split("\n").length;
          } else {
            binary = true;
          }
        }
      } catch {
        // Unreadable; keep the default weight.
      }
      files.push({ path: filePath, weight, binary, status: "A", oldPath: null });
    }
  }

  return files;
}

export function planShards(files, maxShards = DEFAULT_MAX_SHARDS) {
  const totalLines = files.reduce((sum, file) => sum + file.weight, 0);
  const metrics = {
    fileCount: files.length,
    totalLines,
    gate: { minLines: PARALLEL_GATE_MIN_LINES, minFiles: PARALLEL_GATE_MIN_FILES }
  };

  if (totalLines < PARALLEL_GATE_MIN_LINES || files.length < PARALLEL_GATE_MIN_FILES) {
    return {
      mode: "single",
      ...metrics,
      reason: `Below the parallel gate (${totalLines} changed lines / ${files.length} files); one review is cheaper and just as thorough.`
    };
  }

  // Shard by directory boundary first; fall back to per-file units when the
  // whole diff lives in one directory.
  const unitMap = new Map();
  for (const file of files) {
    const key = path.posix.dirname(file.path);
    const unit = unitMap.get(key) ?? { key, files: [], weight: 0 };
    unit.files.push(file);
    unit.weight += file.weight;
    unitMap.set(key, unit);
  }
  let units = [...unitMap.values()];
  if (units.length < 2) {
    units = files.map((file) => ({ key: file.path, files: [file], weight: file.weight }));
  }

  // A single directory that dwarfs the others would become the bottleneck
  // shard and erase the parallel speedup — split oversized units to files.
  const targetShardCount = Math.max(2, Math.min(maxShards, Math.ceil(totalLines / TARGET_LINES_PER_SHARD)));
  const oversizeThreshold = (totalLines / targetShardCount) * OVERSIZE_UNIT_RATIO;
  units = units.flatMap((unit) =>
    unit.weight > oversizeThreshold && unit.files.length > 1
      ? unit.files.map((file) => ({ key: file.path, files: [file], weight: file.weight }))
      : [unit]
  );

  const shardCount = Math.max(2, Math.min(maxShards, units.length, Math.ceil(totalLines / TARGET_LINES_PER_SHARD)));

  const bins = Array.from({ length: shardCount }, () => ({ weight: 0, files: [], dirs: [] }));
  units.sort((a, b) => b.weight - a.weight);
  for (const unit of units) {
    bins.sort((a, b) => a.weight - b.weight);
    bins[0].weight += unit.weight;
    bins[0].files.push(...unit.files);
    bins[0].dirs.push(unit.key);
  }

  bins.sort((a, b) => b.weight - a.weight);
  const shards = bins
    .filter((bin) => bin.files.length > 0)
    .map((bin, index) => ({
      id: `s${index + 1}`,
      weight: bin.weight,
      dirs: [...bin.dirs].sort(),
      files: [...bin.files].sort((a, b) => b.weight - a.weight)
    }));

  return { mode: "parallel", ...metrics, shards };
}

function resolveImportTarget(fromFile, specifier, changedSet) {
  let candidateBase;
  if (specifier.startsWith("@/")) {
    candidateBase = path.posix.join("src", specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    candidateBase = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  } else {
    return null;
  }
  for (const suffix of IMPORT_RESOLVE_SUFFIXES) {
    const candidate = candidateBase + suffix;
    if (changedSet.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

// Mechanical hints for the reduce pass: contracts that cross shard
// boundaries, which no single shard can judge alone. `readFileContent` is
// injected so the planner stays testable without a repository.
export function extractSeamHints({ files, shards, readFileContent }) {
  const shardByFile = new Map();
  for (const shard of shards) {
    for (const file of shard.files) {
      shardByFile.set(file.path, shard.id);
    }
  }
  const changedSet = new Set(shardByFile.keys());
  const seams = [];
  const cssTokenDefinitions = new Map();
  const contents = new Map();

  for (const file of files) {
    if (file.status === "D" || file.binary || !SOURCE_EXTENSIONS.has(path.posix.extname(file.path))) {
      continue;
    }
    const content = readFileContent(file.path);
    if (typeof content === "string") {
      contents.set(file.path, content);
    }
  }

  for (const [filePath, content] of contents) {
    if (!STYLE_EXTENSIONS.has(path.posix.extname(filePath))) {
      continue;
    }
    for (const match of content.matchAll(/--([\w-]+)\s*:/g)) {
      if (!cssTokenDefinitions.has(match[1])) {
        cssTokenDefinitions.set(match[1], filePath);
      }
    }
    if (/:root|\[data-theme|@theme/.test(content)) {
      seams.push({
        kind: "global-style",
        file: filePath,
        shard: shardByFile.get(filePath),
        note: "Global stylesheet/theme tokens changed; every UI shard consumes these values, including through utility classes that never mention the token by name."
      });
    }
  }

  for (const [filePath, content] of contents) {
    const fromShard = shardByFile.get(filePath);

    for (const match of content.matchAll(/(?:from\s+|require\()["']([^"']+)["']/g)) {
      const target = resolveImportTarget(filePath, match[1], changedSet);
      if (target && shardByFile.get(target) !== fromShard) {
        seams.push({
          kind: "import",
          from: filePath,
          fromShard,
          to: target,
          toShard: shardByFile.get(target),
          specifier: match[1]
        });
      }
    }

    for (const match of content.matchAll(/var\(--([\w-]+)\)/g)) {
      const definedIn = cssTokenDefinitions.get(match[1]);
      if (definedIn && definedIn !== filePath && shardByFile.get(definedIn) !== fromShard) {
        seams.push({
          kind: "css-token",
          token: match[1],
          definedIn,
          definedShard: shardByFile.get(definedIn),
          usedIn: filePath,
          usedShard: fromShard
        });
      }
    }
  }

  const seen = new Set();
  return seams
    .filter((seam) => {
      const key = JSON.stringify(seam);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, MAX_SEAM_HINTS);
}

export function buildShardDiff(cwd, target, shard) {
  const argSets = diffArgSets(target);
  const perFile = shard.files.map((file) => {
    const pathspec = file.oldPath ? [file.oldPath, file.path] : [file.path];
    let text = "";
    let oversized = false;
    for (const argSet of argSets) {
      try {
        text += runGit(cwd, ["diff", "-M", ...argSet, "--", ...pathspec], { maxBuffer: MAX_SHARD_DIFF_BYTES + 1 });
      } catch (error) {
        // A single-file diff larger than a shard can inline overflows the
        // buffer; route that file to the reviewer to read directly rather than
        // dropping it silently. Other errors (e.g. an untracked path with no
        // diff) fall through to the embed handling below.
        if (error?.code === "ENOBUFS" || /ENOBUFS|maxBuffer/i.test(error?.message ?? "")) {
          oversized = true;
        }
      }
    }
    if (oversized) {
      return { file, text: "", bytes: 0, omit: true };
    }
    if (!text.trim() && file.status === "A") {
      try {
        const absolute = path.join(cwd, file.path);
        const stat = fs.statSync(absolute);
        if (stat.size <= MAX_UNTRACKED_READ_BYTES) {
          const content = fs.readFileSync(absolute);
          if (isProbablyText(content)) {
            text = `--- new file: ${file.path} ---\n${content.toString("utf8")}\n`;
          }
        }
        if (!text) {
          text = `--- new file: ${file.path} (${stat.size} bytes, content omitted) ---\n`;
        }
      } catch {
        text = "";
      }
    }
    return { file, text, bytes: Buffer.byteLength(text, "utf8"), omit: false };
  });

  const forcedOmitted = perFile.filter((entry) => entry.omit).map((entry) => entry.file.path);
  const inlineable = perFile.filter((entry) => !entry.omit);

  const totalBytes = inlineable.reduce((sum, entry) => sum + entry.bytes, 0);
  if (totalBytes <= MAX_SHARD_DIFF_BYTES) {
    return { text: inlineable.map((entry) => entry.text).join(""), omitted: forcedOmitted };
  }

  // Over budget: keep the heaviest-churn files inline; the reviewer has
  // read-only repository access and can inspect the rest itself.
  const sorted = [...inlineable].sort((a, b) => b.file.weight - a.file.weight);
  let budget = MAX_SHARD_DIFF_BYTES;
  const keep = new Set();
  for (const entry of sorted) {
    if (entry.bytes <= budget) {
      keep.add(entry.file.path);
      budget -= entry.bytes;
    }
  }
  return {
    text: inlineable.filter((entry) => keep.has(entry.file.path)).map((entry) => entry.text).join(""),
    omitted: [
      ...inlineable.filter((entry) => !keep.has(entry.file.path)).map((entry) => entry.file.path),
      ...forcedOmitted
    ]
  };
}

function describeShardFile(file) {
  return `- ${file.path} (${file.status}${file.binary ? ", binary" : `, ~${file.weight} changed lines`})`;
}

export function buildShardPrompt(rootDir, { runLabel, shard, shardCount, targetLabel, invariantsText, focusText, diff }) {
  const omittedBlock = diff.omitted.length
    ? `Diffs omitted for size — inspect these files yourself with read-only git commands:\n${diff.omitted.map((file) => `- ${file}`).join("\n")}`
    : "";
  return interpolateTemplate(loadPromptTemplate(rootDir, "parallel-shard-review"), {
    RUN_LABEL: runLabel,
    SHARD_ID: shard.id,
    SHARD_COUNT: String(shardCount),
    TARGET_LABEL: targetLabel,
    FILE_LIST: shard.files.map(describeShardFile).join("\n"),
    SHARED_INVARIANTS: invariantsText.trim() || "No run-specific invariants were provided; derive the change's implicit contracts from the diff itself.",
    USER_FOCUS: focusText.trim() || "No extra focus provided.",
    REVIEW_INPUT: diff.text.trimEnd(),
    OMITTED_DIFFS: omittedBlock
  });
}

export function buildReducePrompt(rootDir, { runLabel, targetLabel, shards, findings, seams, unparsedCount }) {
  const shardMap = shards
    .map((shard) => `${shard.id}:\n${shard.files.map((file) => `  - ${file.path}`).join("\n")}`)
    .join("\n");
  const compactFindings = findings.map((finding) => ({
    id: finding.id,
    severity: finding.severity,
    confidence: finding.confidence,
    title: finding.title,
    file: finding.file,
    line_start: finding.line_start,
    line_end: finding.line_end,
    shards: finding.shards,
    body: finding.body.slice(0, 600),
    recommendation: finding.recommendation.slice(0, 300)
  }));
  return interpolateTemplate(loadPromptTemplate(rootDir, "parallel-reduce"), {
    RUN_LABEL: runLabel,
    TARGET_LABEL: targetLabel,
    SHARD_COUNT: String(shards.length),
    SHARD_MAP: shardMap,
    MERGED_FINDINGS: JSON.stringify(compactFindings, null, 2),
    SEAM_HINTS: JSON.stringify(seams, null, 2),
    UNPARSED_NOTE: unparsedCount > 0
      ? `Note: ${unparsedCount} shard output(s) failed to parse, so some findings may be missing from the list.`
      : ""
  });
}

export function normalizeShardFinding(raw, shardId) {
  const title = String(raw.title ?? "(untitled)");
  const lineStart = Number.isFinite(raw.line_start) ? raw.line_start : 1;
  return {
    severity: SEVERITY_RANK[raw.severity] ? raw.severity : "medium",
    title,
    body: String(raw.body ?? ""),
    file: String(raw.file ?? "(unknown)"),
    line_start: lineStart,
    line_end: Number.isFinite(raw.line_end) ? raw.line_end : lineStart,
    confidence: Number.isFinite(raw.confidence) ? raw.confidence : 0.5,
    recommendation: String(raw.recommendation ?? ""),
    shards: [shardId],
    sources: [{ shard: shardId, title }]
  };
}

export function bySeverityThenConfidence(a, b) {
  return (
    (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
    (b.confidence ?? 0) - (a.confidence ?? 0)
  );
}

function titleTokens(title) {
  return new Set(
    String(title ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2)
  );
}

function titleSimilarity(a, b) {
  const tokensA = titleTokens(a);
  const tokensB = titleTokens(b);
  if (tokensA.size === 0 || tokensB.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      shared += 1;
    }
  }
  return shared / (tokensA.size + tokensB.size - shared);
}

function rangesRelated(a, b) {
  const gap = 5;
  return a.line_start <= b.line_end + gap && b.line_start <= a.line_end + gap;
}

function absorbFinding(target, incoming) {
  if ((SEVERITY_RANK[incoming.severity] ?? 0) > (SEVERITY_RANK[target.severity] ?? 0)) {
    target.severity = incoming.severity;
  }
  target.confidence = Math.max(target.confidence ?? 0, incoming.confidence ?? 0);
  if (String(incoming.body ?? "").length > String(target.body ?? "").length) {
    target.body = incoming.body;
  }
  if (String(incoming.recommendation ?? "").length > String(target.recommendation ?? "").length) {
    target.recommendation = incoming.recommendation;
  }
  target.line_start = Math.min(target.line_start, incoming.line_start);
  target.line_end = Math.max(target.line_end, incoming.line_end);
  for (const shard of incoming.shards) {
    if (!target.shards.includes(shard)) {
      target.shards.push(shard);
    }
  }
  target.sources.push(...incoming.sources);
}

export function mergeFindings(findings) {
  const merged = [];
  for (const finding of findings) {
    const existing = merged.find(
      (candidate) =>
        candidate.file === finding.file &&
        (rangesRelated(candidate, finding)
          ? titleSimilarity(candidate.title, finding.title) >= 0.3
          : titleSimilarity(candidate.title, finding.title) >= 0.6)
    );
    if (existing) {
      absorbFinding(existing, finding);
    } else {
      merged.push(finding);
    }
  }
  merged.sort(bySeverityThenConfidence);
  return merged;
}

// Ids must be assigned once, after merging, and stay stable: the reduce turn
// receives them in its prompt and its verdicts are joined back on the same ids.
export function assignFindingIds(findings) {
  findings.forEach((finding, index) => {
    finding.id = `f${index + 1}`;
  });
  return findings;
}

export function extractJsonPayload(rawOutput, isValid) {
  if (!rawOutput || !rawOutput.trim()) {
    return { error: "empty output" };
  }
  const candidates = [];
  const fenced = rawOutput.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    candidates.push(fenced[1]);
  }
  candidates.push(rawOutput.trim());
  const first = rawOutput.indexOf("{");
  const last = rawOutput.lastIndexOf("}");
  if (first !== -1 && last > first) {
    candidates.push(rawOutput.slice(first, last + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && isValid(parsed)) {
        return { payload: parsed };
      }
    } catch {
      // Try the next candidate shape.
    }
  }
  return { error: "no schema-shaped JSON object found in the output" };
}

export function applyReduceOutcome(findings, reducePayload) {
  const byId = new Map(
    (reducePayload.assessments ?? []).map((assessment) => [String(assessment.id), assessment])
  );
  // Count only assessments that matched one of our findings: an id the
  // reducer invented must not compensate for an id it skipped.
  let assessed = 0;
  for (const finding of findings) {
    const assessment = byId.get(finding.id);
    if (assessment) {
      assessed += 1;
    }
    finding.verification = REDUCE_VERDICTS.has(assessment?.verdict) ? assessment.verdict : "SUSPECTED";
    finding.reduceNote = assessment?.note ?? null;
  }

  const seamFindings = (reducePayload.seam_findings ?? []).map((raw, index) => {
    const normalized = normalizeShardFinding(raw, "reduce");
    normalized.id = `sf${index + 1}`;
    normalized.origin = "reduce";
    normalized.verification = "SUSPECTED";
    normalized.relatedFiles = Array.isArray(raw.related_files) ? raw.related_files : [];
    return normalized;
  });

  return { seamFindings, assessed };
}

function formatFindingLine(finding) {
  const verification = finding.verification ? ` [${finding.verification}]` : "";
  const origin = finding.origin === "reduce" ? "reduce" : finding.shards.join("+");
  const confidence = Math.round((finding.confidence ?? 0) * 100);
  return [
    `- (${finding.severity}/${confidence}%)${verification} ${finding.file}:${finding.line_start} — ${finding.title} (${origin})`,
    finding.body ? `  ${finding.body.split("\n").join("\n  ")}` : null,
    finding.recommendation ? `  Fix: ${finding.recommendation.split("\n").join("\n  ")}` : null,
    finding.reduceNote ? `  Integration note: ${finding.reduceNote}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderParallelReviewResult(payload) {
  const lines = [];
  lines.push(`Parallel review of ${payload.target.label}: ${payload.shards.length} shards + 1 integration pass.`);
  lines.push("");
  if (payload.reduce?.summary) {
    lines.push(`Integration verdict: ${payload.reduce.summary}`);
    lines.push("");
  }

  const active = payload.findings.filter((finding) => finding.verification !== "REJECTED");
  const rejected = payload.findings.filter((finding) => finding.verification === "REJECTED");

  if (active.length === 0) {
    lines.push("No findings survived the shard reviews and the integration pass.");
  } else {
    lines.push(`Findings (${active.length}, ranked):`);
    for (const finding of active) {
      lines.push(formatFindingLine(finding));
    }
  }

  if (rejected.length > 0) {
    lines.push("");
    lines.push(`Disproven by the integration pass (${rejected.length}):`);
    for (const finding of rejected) {
      lines.push(`- ${finding.file}:${finding.line_start} — ${finding.title}${finding.reduceNote ? ` (${finding.reduceNote})` : ""}`);
    }
  }

  if (payload.unparsed.length > 0) {
    lines.push("");
    lines.push(`Warning: ${payload.unparsed.length} shard output(s) could not be parsed; their findings are missing:`);
    for (const entry of payload.unparsed) {
      lines.push(`- ${entry.shard} (${entry.jobId}): ${entry.error}`);
    }
  }

  const outOfScope = payload.shards.filter((shard) => shard.outOfScope > 0);
  if (outOfScope.length > 0) {
    const total = outOfScope.reduce((sum, shard) => sum + shard.outOfScope, 0);
    lines.push("");
    lines.push(`Note: ${total} finding(s) were dropped for citing files outside their shard's ownership:`);
    for (const shard of outOfScope) {
      lines.push(`- ${shard.shard}: ${shard.outOfScope} out-of-scope`);
    }
  }

  lines.push("");
  lines.push("Wall times:");
  for (const shard of payload.shards) {
    const retries = shard.retries > 0 ? `, ${shard.retries} recovery` : "";
    lines.push(`- ${shard.shard}: ${shard.status}${shard.wallSec != null ? ` in ${shard.wallSec}s` : ""}${retries}`);
  }
  if (payload.reduce) {
    lines.push(`- reduce: ${payload.reduce.status}${payload.reduce.wallSec != null ? ` in ${payload.reduce.wallSec}s` : ""}`);
  }
  if (payload.totals?.wallSec != null) {
    lines.push(`- total: ${payload.totals.wallSec}s end-to-end`);
  }

  return `${lines.join("\n")}\n`;
}
