import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  applyReduceOutcome,
  assignFindingIds,
  buildShardDiff,
  collectChangedFiles,
  readReviewedFileContent,
  extractJsonPayload,
  extractSeamHints,
  mergeFindings,
  normalizeRenamePath,
  normalizeShardFinding,
  planShards,
  renderParallelReviewResult
} from "../plugins/codex/scripts/lib/parallel-review.mjs";
import { isPidAlive } from "../plugins/codex/scripts/lib/process.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function makeFile(filePath, weight, overrides = {}) {
  return { path: filePath, weight, binary: false, status: "M", oldPath: null, ...overrides };
}

test("planShards gates small diffs to a single review", () => {
  const files = [makeFile("src/a.ts", 120), makeFile("src/b.ts", 90)];
  const plan = planShards(files, 4);

  assert.equal(plan.mode, "single");
  assert.match(plan.reason, /parallel gate/i);
});

test("planShards keeps directory units together and balances shard weight", () => {
  const files = [
    makeFile("client/one.ts", 100),
    makeFile("client/two.ts", 100),
    makeFile("server/one.ts", 100),
    makeFile("server/two.ts", 100),
    makeFile("styles/app.css", 100),
    makeFile("routes/index.ts", 100),
    makeFile("lib/util.ts", 100),
    makeFile("tests/app.test.ts", 100)
  ];
  const plan = planShards(files, 4);

  assert.equal(plan.mode, "parallel");
  assert.equal(plan.shards.length, 2);
  const weights = plan.shards.map((shard) => shard.weight);
  assert.equal(Math.max(...weights) - Math.min(...weights), 0);
  for (const shard of plan.shards) {
    const dirs = new Set(shard.files.map((file) => file.path.split("/")[0]));
    for (const dir of dirs) {
      const dirFiles = files.filter((file) => file.path.startsWith(`${dir}/`));
      const inShard = shard.files.filter((file) => file.path.startsWith(`${dir}/`));
      assert.equal(inShard.length, dirFiles.length, `directory ${dir} must not be split across shards`);
    }
  }
});

test("planShards splits an oversized directory so it cannot become the bottleneck", () => {
  const files = [
    ...Array.from({ length: 10 }, (_, index) => makeFile(`big/file-${index}.ts`, 140)),
    makeFile("small/a.ts", 60),
    makeFile("small/b.ts", 60),
    makeFile("other/c.ts", 60)
  ];
  const plan = planShards(files, 4);

  assert.equal(plan.mode, "parallel");
  assert.equal(plan.shards.length, 4);
  const heaviest = Math.max(...plan.shards.map((shard) => shard.weight));
  const total = files.reduce((sum, file) => sum + file.weight, 0);
  assert.ok(heaviest < total * 0.5, `oversized dir must be split (heaviest shard ${heaviest} of ${total})`);
});

test("normalizeRenamePath handles both numstat rename spellings", () => {
  assert.equal(normalizeRenamePath("src/{old.ts => new.ts}"), "src/new.ts");
  assert.equal(normalizeRenamePath("a/{b => c}/d.ts"), "a/c/d.ts");
  assert.equal(normalizeRenamePath("old.ts => new.ts"), "new.ts");
  assert.equal(normalizeRenamePath("plain/path.ts"), "plain/path.ts");
});

test("extractSeamHints reports imports, css tokens, and global styles crossing shards", () => {
  const files = [
    makeFile("src/styles/app.css", 50),
    makeFile("src/ui/button.tsx", 50),
    makeFile("src/lib/util.ts", 50)
  ];
  const shards = [
    { id: "s1", files: [files[0]] },
    { id: "s2", files: [files[1], files[2]] }
  ];
  const contents = {
    "src/styles/app.css": ":root {\n  --color-accent: oklch(60% 0.1 200 / 0.5);\n}\n",
    "src/ui/button.tsx": "import { helper } from \"../lib/util\";\nconst style = { color: \"var(--color-accent)\" };\n",
    "src/lib/util.ts": "export function helper() {}\n"
  };
  const seams = extractSeamHints({ files, shards, readFileContent: (p) => contents[p] ?? null });

  const kinds = seams.map((seam) => seam.kind).sort();
  assert.deepEqual([...new Set(kinds)], ["css-token", "global-style"]);
  const token = seams.find((seam) => seam.kind === "css-token");
  assert.equal(token.token, "color-accent");
  assert.equal(token.definedShard, "s1");
  assert.equal(token.usedShard, "s2");
  // button.tsx imports util.ts, but both live in s2 — no seam.
  assert.equal(seams.some((seam) => seam.kind === "import"), false);
});

test("extractSeamHints resolves relative imports that cross shards", () => {
  const files = [makeFile("src/ui/button.tsx", 50), makeFile("src/lib/util.ts", 50)];
  const shards = [
    { id: "s1", files: [files[0]] },
    { id: "s2", files: [files[1]] }
  ];
  const contents = {
    "src/ui/button.tsx": "import { helper } from \"../lib/util\";\n",
    "src/lib/util.ts": "export function helper() {}\n"
  };
  const seams = extractSeamHints({ files, shards, readFileContent: (p) => contents[p] ?? null });

  assert.equal(seams.length, 1);
  assert.equal(seams[0].kind, "import");
  assert.equal(seams[0].from, "src/ui/button.tsx");
  assert.equal(seams[0].to, "src/lib/util.ts");
});

test("mergeFindings dedupes overlapping findings and keeps the worst severity", () => {
  const findings = [
    normalizeShardFinding(
      { severity: "medium", title: "Token alpha stacks with modifier", file: "app.css", line_start: 10, line_end: 14, confidence: 0.7, body: "short", recommendation: "fix" },
      "s1"
    ),
    normalizeShardFinding(
      { severity: "high", title: "Alpha token stacks with opacity modifier", file: "app.css", line_start: 12, line_end: 16, confidence: 0.9, body: "a longer explanation of the same defect", recommendation: "fix it properly" },
      "s2"
    ),
    normalizeShardFinding(
      { severity: "low", title: "Unrelated finding", file: "other.ts", line_start: 1, line_end: 2, confidence: 0.5, body: "x", recommendation: "y" },
      "s1"
    )
  ];
  const merged = assignFindingIds(mergeFindings(findings));

  assert.equal(merged.length, 2);
  assert.equal(merged[0].severity, "high");
  assert.equal(merged[0].confidence, 0.9);
  assert.deepEqual([...merged[0].shards].sort(), ["s1", "s2"]);
  assert.equal(merged[0].id, "f1");
  assert.equal(merged[0].sources.length, 2);
});

test("applyReduceOutcome joins verdicts by id and defaults unassessed findings to SUSPECTED", () => {
  const findings = assignFindingIds(
    mergeFindings([
      normalizeShardFinding({ severity: "high", title: "A", file: "a.ts", line_start: 1, line_end: 1, confidence: 0.9, body: "a", recommendation: "r" }, "s1"),
      normalizeShardFinding({ severity: "low", title: "B", file: "b.ts", line_start: 1, line_end: 1, confidence: 0.5, body: "b", recommendation: "r" }, "s2")
    ])
  );
  const { seamFindings, assessed } = applyReduceOutcome(findings, {
    summary: "verdict",
    assessments: [{ id: "f1", verdict: "REJECTED", note: "disproven" }],
    seam_findings: [
      { severity: "high", title: "Cross-shard defect", body: "spans two shards", file: "a.ts", line_start: 5, line_end: 6, confidence: 0.8, recommendation: "fix", related_files: ["b.ts"] }
    ]
  });

  assert.equal(assessed, 1);
  assert.equal(findings[0].verification, "REJECTED");
  assert.equal(findings[0].reduceNote, "disproven");
  assert.equal(findings[1].verification, "SUSPECTED");
  assert.equal(seamFindings.length, 1);
  assert.equal(seamFindings[0].id, "sf1");
  assert.equal(seamFindings[0].origin, "reduce");
  assert.deepEqual(seamFindings[0].relatedFiles, ["b.ts"]);
});

test("extractJsonPayload tolerates fences and surrounding prose", () => {
  const valid = (parsed) => Array.isArray(parsed.findings);
  const object = { verdict: "approve", summary: "ok", findings: [], next_steps: [] };

  assert.deepEqual(extractJsonPayload(JSON.stringify(object), valid).payload, object);
  assert.deepEqual(extractJsonPayload("```json\n" + JSON.stringify(object) + "\n```", valid).payload, object);
  assert.deepEqual(extractJsonPayload("Here is my verdict:\n" + JSON.stringify(object) + "\nDone.", valid).payload, object);
  assert.match(extractJsonPayload("no json here", valid).error, /no schema-shaped/i);
  assert.match(extractJsonPayload("", valid).error, /empty/i);
});

test("renderParallelReviewResult separates active and rejected findings", () => {
  const findings = assignFindingIds(
    mergeFindings([
      normalizeShardFinding({ severity: "high", title: "Real defect", file: "a.ts", line_start: 1, line_end: 1, confidence: 0.9, body: "explanation", recommendation: "fix" }, "s1"),
      normalizeShardFinding({ severity: "low", title: "False alarm", file: "b.ts", line_start: 2, line_end: 2, confidence: 0.4, body: "meh", recommendation: "" }, "s2")
    ])
  );
  applyReduceOutcome(findings, {
    summary: "one real issue",
    assessments: [
      { id: "f1", verdict: "CONFIRMED", note: "verified" },
      { id: "f2", verdict: "REJECTED", note: "not reachable" }
    ],
    seam_findings: []
  });
  const rendered = renderParallelReviewResult({
    target: { label: "base main...HEAD" },
    shards: [{ shard: "s1", status: "completed", wallSec: 100, retries: 0 }],
    reduce: { status: "completed", wallSec: 40, summary: "one real issue" },
    findings,
    unparsed: [],
    totals: { wallSec: 150, shardCount: 1 }
  });

  assert.match(rendered, /Real defect/);
  assert.match(rendered, /\[CONFIRMED\]/);
  assert.match(rendered, /Disproven by the integration pass \(1\)/);
  assert.match(rendered, /not reachable/);
  assert.match(rendered, /total: 150s end-to-end/);
});

test("isPidAlive distinguishes the current process from a dead pid", () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(2 ** 30), false);
  assert.equal(isPidAlive(Number.NaN), false);
  assert.equal(isPidAlive(-1), false);
});

test("working-tree collection sees staged edits a worktree revert hides", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const filePath = path.join(repo, "src", "a.txt");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "original\n", "utf8");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "base"], { cwd: repo });

  // Stage an edit, then revert the worktree copy: `git diff HEAD` is empty
  // for this path, but committing now would still land the staged edit.
  fs.writeFileSync(filePath, "staged edit\n", "utf8");
  run("git", ["add", "src/a.txt"], { cwd: repo });
  fs.writeFileSync(filePath, "original\n", "utf8");

  const target = { mode: "working-tree", label: "working tree" };
  const files = collectChangedFiles(repo, target);
  const entry = files.find((file) => file.path === "src/a.txt");
  assert.ok(entry, "expected the staged-but-reverted file to be collected");

  const diff = buildShardDiff(repo, target, { id: "A", files: [entry] });
  assert.match(diff.text, /staged edit/);
});

test("applyReduceOutcome does not count assessments for unknown ids", () => {
  const findings = assignFindingIds(
    mergeFindings([
      normalizeShardFinding({ severity: "high", title: "A", file: "a.ts", line_start: 1, line_end: 1, confidence: 0.9, body: "a", recommendation: "r" }, "s1"),
      normalizeShardFinding({ severity: "low", title: "B", file: "b.ts", line_start: 5, line_end: 5, confidence: 0.5, body: "b", recommendation: "r" }, "s2")
    ])
  );
  const { assessed } = applyReduceOutcome(findings, {
    assessments: [
      { id: "f1", verdict: "CONFIRMED", note: "checked" },
      { id: "f9", verdict: "REJECTED", note: "hallucinated id" }
    ],
    seam_findings: []
  });

  assert.equal(assessed, 1);
  assert.equal(findings[0].verification, "CONFIRMED");
  assert.equal(findings[1].verification, "SUSPECTED");
});

test("collectChangedFiles caps untracked reads and flags binary content", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n", "utf8");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "base"], { cwd: repo });

  fs.writeFileSync(path.join(repo, "small.txt"), "one\ntwo\nthree\n", "utf8");
  fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([0, 1, 2, 0, 3]));
  fs.writeFileSync(path.join(repo, "huge.txt"), "x".repeat(30 * 1024), "utf8");

  const target = { mode: "working-tree", label: "working tree" };
  const files = collectChangedFiles(repo, target);
  const byPath = new Map(files.map((file) => [file.path, file]));

  assert.equal(byPath.get("small.txt").weight, 4);
  assert.equal(byPath.get("blob.bin").binary, true);
  // Oversized content is never read; the default weight stands in.
  assert.equal(byPath.get("huge.txt").weight, byPath.get("blob.bin").weight);

  const diff = buildShardDiff(repo, target, { id: "A", files: [byPath.get("huge.txt")] });
  assert.match(diff.text, /content omitted/);
});

test("buildShardDiff omits an oversized single-file diff instead of dropping it silently", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const filePath = path.join(repo, "big.txt");
  // A committed file whose full rewrite produces a diff well over the shard
  // inline budget (~150KB): ~6000 lines each replaced.
  const original = Array.from({ length: 6000 }, (_, i) => `original line ${i} ${"x".repeat(20)}`).join("\n");
  fs.writeFileSync(filePath, `${original}\n`, "utf8");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "base"], { cwd: repo });
  const rewritten = Array.from({ length: 6000 }, (_, i) => `changed line ${i} ${"y".repeat(20)}`).join("\n");
  fs.writeFileSync(filePath, `${rewritten}\n`, "utf8");

  const target = { mode: "working-tree", label: "working tree" };
  const file = { path: "big.txt", weight: 12000, binary: false, status: "M", oldPath: null };
  const diff = buildShardDiff(repo, target, { id: "A", files: [file] });

  assert.deepEqual(diff.omitted, ["big.txt"]);
  assert.equal(diff.text.includes("changed line"), false, "oversized diff must not be inlined");
});

test("readReviewedFileContent reads the reviewed snapshot, not a dirty worktree or a reverted stage", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const rel = "src/mod.ts";
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), "export const committed = 1;\n", "utf8");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "base"], { cwd: repo });

  // Branch review: the reviewed content is HEAD, even with an unrelated dirty
  // worktree edit on top.
  fs.writeFileSync(path.join(repo, rel), "export const dirtyWorktree = 2;\n", "utf8");
  const branchContent = readReviewedFileContent(repo, { mode: "branch", baseRef: "main" }, rel);
  assert.match(branchContent, /committed/);
  assert.equal(/dirtyWorktree/.test(branchContent), false, "branch review must not read uncommitted worktree edits");

  // Working-tree review: a staged change whose worktree copy was reverted must
  // still be visible (scanned from the index), so its seams are not missed.
  fs.writeFileSync(path.join(repo, rel), "import { token } from './staged';\n", "utf8");
  run("git", ["add", rel], { cwd: repo });
  fs.writeFileSync(path.join(repo, rel), "export const committed = 1;\n", "utf8");
  const wtContent = readReviewedFileContent(repo, { mode: "working-tree", label: "working tree" }, rel);
  assert.match(wtContent, /token/, "working-tree review must scan staged content even when the worktree reverted it");
});
