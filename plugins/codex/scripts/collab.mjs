#!/usr/bin/env node
// collab — Claude/Codex peer-collaboration runtime (fork addition).
// Shared workspace lives at <main-checkout>/.codex-claude (gitignored via .git/info/exclude).
// Self-contained on purpose: no imports from upstream lib/ so upstream merges stay clean.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runQueuedCodexExec } from "./lib/exec-launcher.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROTOCOL_TEMPLATE = path.join(path.dirname(SCRIPT_PATH), "..", "prompts", "collab-protocol.md");
const COLLAB_DIR_NAME = ".codex-claude";
const COLLAB_EXEC_TIMEOUT_MS = 1800000;
const COLLAB_QUEUE_WAIT_MS = 3600000;
const AGENTS = new Set(["codex", "claude"]);
const MESSAGE_TYPES = new Set([
  "assign",
  "status",
  "question",
  "claim",
  "handoff",
  "review",
  "rebuttal",
  "decision"
]);

function fail(message) {
  process.stderr.write(`collab: ${message}\n`);
  process.exit(1);
}

function git(cwd, args, options = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", ...options });
  if (result.status !== 0 && !options.allowFailure) {
    fail(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result;
}

function resolveMainRoot(cwd) {
  const result = spawnSync(
    "git",
    ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    fail("not inside a git repository");
  }
  return path.dirname(result.stdout.trim());
}

function collabPaths(mainRoot) {
  const dir = path.join(mainRoot, COLLAB_DIR_NAME);
  return {
    dir,
    mailbox: path.join(dir, "mailbox.jsonl"),
    claims: path.join(dir, "claims.json"),
    assignments: path.join(dir, "assignments.json"),
    decisions: path.join(dir, "decisions.md"),
    cursors: path.join(dir, "cursors"),
    logs: path.join(dir, "logs")
  };
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureInit(mainRoot) {
  const paths = collabPaths(mainRoot);
  fs.mkdirSync(paths.cursors, { recursive: true });
  fs.mkdirSync(paths.logs, { recursive: true });
  if (!fs.existsSync(paths.mailbox)) {
    fs.writeFileSync(paths.mailbox, "", "utf8");
  }
  if (!fs.existsSync(paths.claims)) {
    writeJson(paths.claims, []);
  }
  if (!fs.existsSync(paths.assignments)) {
    writeJson(paths.assignments, {});
  }
  if (!fs.existsSync(paths.decisions)) {
    fs.writeFileSync(paths.decisions, "# Decisions\n", "utf8");
  }
  const excludeFile = path.join(mainRoot, ".git", "info", "exclude");
  const marker = `${COLLAB_DIR_NAME}/`;
  const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
  if (!existing.split("\n").includes(marker)) {
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    fs.appendFileSync(excludeFile, `${existing.endsWith("\n") || existing === "" ? "" : "\n"}${marker}\n`, "utf8");
  }
  return paths;
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

function readMessages(paths) {
  const raw = fs.readFileSync(paths.mailbox, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function appendMessage(paths, message) {
  const record = {
    ts: new Date().toISOString(),
    from: message.from,
    type: message.type,
    issue: message.issue ?? null,
    body: message.body,
    refs: message.refs ?? []
  };
  fs.appendFileSync(paths.mailbox, `${JSON.stringify(record)}\n`, "utf8");
  if (record.type === "decision") {
    fs.appendFileSync(
      paths.decisions,
      `\n## ${record.ts} · ${record.issue ?? "general"} · ${record.from}\n\n${record.body}\n`,
      "utf8"
    );
  }
  return record;
}

function requireAgent(value, label = "--from/--agent") {
  if (!value || !AGENTS.has(value)) {
    fail(`${label} must be one of: codex, claude`);
  }
  return value;
}

function requireIssue(assignments, slug) {
  if (!slug || !assignments[slug]) {
    fail(`unknown issue "${slug ?? ""}". Known: ${Object.keys(assignments).join(", ") || "(none)"}`);
  }
  return assignments[slug];
}

function pathsOverlap(a, b) {
  const na = a.replace(/\/+$/, "");
  const nb = b.replace(/\/+$/, "");
  return na === nb || na.startsWith(`${nb}/`) || nb.startsWith(`${na}/`);
}

function findConflicts(claims) {
  const conflicts = [];
  for (const mine of claims) {
    for (const theirs of claims) {
      if (mine.agent >= theirs.agent) {
        continue;
      }
      for (const p1 of mine.paths) {
        for (const p2 of theirs.paths) {
          if (pathsOverlap(p1, p2)) {
            conflicts.push({ path: p1, otherPath: p2, agents: [mine.agent, theirs.agent], issues: [mine.issue, theirs.issue] });
          }
        }
      }
    }
  }
  return conflicts;
}

function printConflicts(conflicts) {
  if (conflicts.length === 0) {
    console.log("No claim conflicts.");
    return;
  }
  for (const conflict of conflicts) {
    console.log(
      `CONFLICT: ${conflict.agents[0]} (${conflict.issues[0]}) and ${conflict.agents[1]} (${conflict.issues[1]}) both touch ${conflict.path}${conflict.path === conflict.otherPath ? "" : ` / ${conflict.otherPath}`}`
    );
  }
}

function cmdInit(mainRoot) {
  ensureInit(mainRoot);
  console.log(`Initialized ${path.join(mainRoot, COLLAB_DIR_NAME)}`);
}

function cmdAssign(mainRoot, flags) {
  const paths = ensureInit(mainRoot);
  const agent = requireAgent(flags.agent, "--agent");
  const slug = typeof flags.issue === "string" ? flags.issue : "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    fail("--issue must be a lowercase slug (a-z, 0-9, hyphens)");
  }
  const assignments = readJson(paths.assignments, {});
  if (assignments[slug]) {
    fail(`issue "${slug}" is already assigned to ${assignments[slug].agent}`);
  }
  const branch = `${agent}/${slug}`;
  const repoBase = path.basename(mainRoot);
  const worktree = path.join(path.dirname(mainRoot), `${repoBase}--${agent}-${slug}`);
  const base = git(mainRoot, ["symbolic-ref", "--short", "HEAD"]).stdout.trim();
  git(mainRoot, ["worktree", "add", "-b", branch, worktree]);
  assignments[slug] = {
    issue: slug,
    agent,
    title: typeof flags.title === "string" ? flags.title : slug,
    branch,
    base,
    worktree,
    sessions: [],
    status: "active",
    created: new Date().toISOString()
  };
  writeJson(paths.assignments, assignments);
  appendMessage(paths, {
    from: agent === "codex" ? "claude" : "codex",
    type: "assign",
    issue: slug,
    body: `Issue "${assignments[slug].title}" assigned to ${agent} on branch ${branch} (worktree ${worktree}).`
  });
  console.log(`Assigned ${slug} to ${agent}.`);
  console.log(`  branch:   ${branch} (base ${base})`);
  console.log(`  worktree: ${worktree}`);
}

function cmdPost(mainRoot, flags) {
  const paths = ensureInit(mainRoot);
  const from = requireAgent(flags.from, "--from");
  const type = typeof flags.type === "string" ? flags.type : "";
  if (!MESSAGE_TYPES.has(type)) {
    fail(`--type must be one of: ${[...MESSAGE_TYPES].join(", ")}`);
  }
  if (typeof flags.body !== "string" || flags.body.trim() === "") {
    fail("--body is required");
  }
  const record = appendMessage(paths, {
    from,
    type,
    issue: typeof flags.issue === "string" ? flags.issue : null,
    body: flags.body,
    refs: typeof flags.refs === "string" ? flags.refs.split(",").map((ref) => ref.trim()).filter(Boolean) : []
  });
  console.log(`Posted ${record.type} from ${record.from}.`);
}

function cmdInbox(mainRoot, flags) {
  const paths = ensureInit(mainRoot);
  const agent = requireAgent(flags.for, "--for");
  const cursorFile = path.join(paths.cursors, agent);
  const cursor = fs.existsSync(cursorFile) ? Number(fs.readFileSync(cursorFile, "utf8").trim()) || 0 : 0;
  const all = readMessages(paths);
  const fresh = all.slice(cursor).filter((message) => message.from !== agent);
  if (fresh.length === 0) {
    console.log("No new messages.");
  } else {
    for (const message of fresh) {
      console.log(JSON.stringify(message));
    }
  }
  if (!flags.peek) {
    fs.writeFileSync(cursorFile, String(all.length), "utf8");
  }
}

function cmdClaim(mainRoot, flags) {
  const paths = ensureInit(mainRoot);
  const agent = requireAgent(flags.agent, "--agent");
  const issue = typeof flags.issue === "string" ? flags.issue : null;
  const claimedPaths = typeof flags.paths === "string" ? flags.paths.split(",").map((p) => p.trim()).filter(Boolean) : [];
  if (claimedPaths.length === 0) {
    fail("--paths is required (comma-separated repo-relative paths)");
  }
  const claims = readJson(paths.claims, []);
  const existing = claims.find((claim) => claim.agent === agent && claim.issue === issue);
  if (existing) {
    existing.paths = [...new Set([...existing.paths, ...claimedPaths])];
    existing.ts = new Date().toISOString();
  } else {
    claims.push({ agent, issue, paths: claimedPaths, ts: new Date().toISOString() });
  }
  writeJson(paths.claims, claims);
  appendMessage(paths, { from: agent, type: "claim", issue, body: `Claimed: ${claimedPaths.join(", ")}` });
  printConflicts(findConflicts(claims).filter((conflict) => conflict.agents.includes(agent)));
}

function cmdConflicts(mainRoot) {
  const paths = ensureInit(mainRoot);
  printConflicts(findConflicts(readJson(paths.claims, [])));
}

function cmdHandoff(mainRoot, flags) {
  const paths = ensureInit(mainRoot);
  const assignments = readJson(paths.assignments, {});
  const assignment = requireIssue(assignments, flags.issue);
  const diffStat = git(assignment.worktree, ["diff", "--stat", `${assignment.base}...HEAD`]).stdout.trim();
  const summary = typeof flags.summary === "string" ? flags.summary : "Ready for cross-review.";
  appendMessage(paths, {
    from: assignment.agent,
    type: "handoff",
    issue: assignment.issue,
    body: `${summary}\n\n${diffStat || "(no committed changes yet)"}`,
    refs: [assignment.branch, assignment.worktree]
  });
  assignment.status = "handoff";
  writeJson(paths.assignments, assignments);
  console.log(`Handoff posted for ${assignment.issue} (${assignment.branch}).`);
  const lastSession = assignment.sessions[assignment.sessions.length - 1];
  if (lastSession) {
    console.log(`Pick up yourself: cd ${assignment.worktree} && codex resume ${lastSession}`);
  }
}

async function cmdRun(mainRoot, flags) {
  const paths = ensureInit(mainRoot);
  const assignments = readJson(paths.assignments, {});
  const assignment = requireIssue(assignments, flags.issue);
  if (assignment.agent !== "codex") {
    fail(`issue "${assignment.issue}" is assigned to claude; collab run only drives codex`);
  }
  if (typeof flags.prompt !== "string" || flags.prompt.trim() === "") {
    fail("--prompt is required");
  }
  const resumeSession =
    flags.resume === true
      ? assignment.sessions[assignment.sessions.length - 1]
      : typeof flags.resume === "string"
        ? flags.resume
        : null;
  if (flags.resume === true && !resumeSession) {
    fail(`issue "${assignment.issue}" has no recorded session to resume`);
  }
  let fullPrompt;
  if (resumeSession) {
    fullPrompt = flags.prompt;
  } else {
    const template = fs.readFileSync(PROTOCOL_TEMPLATE, "utf8");
    const protocol = template
      .replaceAll("{{ISSUE}}", assignment.issue)
      .replaceAll("{{TITLE}}", assignment.title)
      .replaceAll("{{REPO}}", path.basename(mainRoot))
      .replaceAll("{{COLLAB_CLI}}", SCRIPT_PATH)
      .replaceAll("{{COLLAB_DIR}}", paths.dir);
    const titleLine = `[${path.basename(mainRoot)} · ${assignment.issue} · codex] ${assignment.title}`;
    fullPrompt = `${titleLine}\n\n${protocol}\n\n${flags.prompt}`;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(paths.logs, `${assignment.issue}-${stamp}.log`);
  const finalFile = path.join(paths.logs, `${assignment.issue}-${stamp}-final.md`);
  // A linked worktree's git metadata (index, refs, objects) lives under the main
  // checkout's .git — commits from the worktree need it writable. `exec resume`
  // has no -s/-C/--add-dir flags, so the same sandbox is expressed via -c
  // overrides there; a resumed session keeps its original workdir.
  const extraRoots = [paths.dir, path.join(mainRoot, ".git")];
  const args = ["exec"];
  if (resumeSession) {
    args.push(
      "resume",
      resumeSession,
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      `sandbox_workspace_write.writable_roots=${JSON.stringify(extraRoots)}`
    );
  } else {
    args.push("-s", "workspace-write", "-C", assignment.worktree);
    for (const root of extraRoots) {
      args.push("--add-dir", root);
    }
  }
  args.push("-o", finalFile);
  if (typeof flags.effort === "string") {
    args.push("-c", `model_reasoning_effort="${flags.effort}"`);
  }
  if (typeof flags.model === "string") {
    args.push("-m", flags.model);
  }
  args.push(fullPrompt);
  // One launcher for every plugin-owned `codex exec`: the run takes the global
  // Codex slot, never inherits stdin, and is killed at its deadline.
  const result = await runQueuedCodexExec({
    args,
    cwd: assignment.worktree,
    logFile,
    appendLog: false,
    kind: "collab",
    jobId: `collab-${assignment.issue}-${stamp}`,
    timeoutMs: COLLAB_EXEC_TIMEOUT_MS,
    queueWaitMs: COLLAB_QUEUE_WAIT_MS
  });
  if (result.timedOut) {
    fail(`codex exec exceeded its ${COLLAB_EXEC_TIMEOUT_MS}ms deadline; see ${logFile}`);
  }
  const log = fs.readFileSync(logFile, "utf8");
  const sessionMatch = log.match(/session id: ([0-9a-f-]+)/);
  if (sessionMatch && assignment.sessions[assignment.sessions.length - 1] !== sessionMatch[1]) {
    assignment.sessions.push(sessionMatch[1]);
    writeJson(paths.assignments, assignments);
  }
  if (result.status !== 0) {
    fail(`codex exec failed (exit ${result.status}); see ${logFile}`);
  }
  const finalMessage = fs.existsSync(finalFile) ? fs.readFileSync(finalFile, "utf8").trim() : "(no final message)";
  console.log(finalMessage);
  console.log("");
  console.log(`session: ${sessionMatch ? sessionMatch[1] : "unknown"} · log: ${logFile}`);
  if (sessionMatch) {
    console.log(`Pick up yourself: cd ${assignment.worktree} && codex resume ${sessionMatch[1]}`);
  }
}

function cmdMerge(mainRoot, flags) {
  const paths = ensureInit(mainRoot);
  const assignments = readJson(paths.assignments, {});
  const assignment = requireIssue(assignments, flags.issue);
  const reviewer = assignment.agent === "codex" ? "claude" : "codex";
  const reviews = readMessages(paths).filter(
    (message) => message.type === "review" && message.issue === assignment.issue && message.from === reviewer
  );
  const latest = reviews[reviews.length - 1];
  if (!latest || !/^approve/i.test(latest.body.trim())) {
    fail(
      `cannot merge "${assignment.issue}": latest review from ${reviewer} must start with "approve" (found: ${latest ? JSON.stringify(latest.body.slice(0, 60)) : "no review"})`
    );
  }
  git(mainRoot, ["merge", "--no-ff", assignment.branch, "-m", `Merge ${assignment.branch}: ${assignment.title}`]);
  git(mainRoot, ["worktree", "remove", "--force", assignment.worktree]);
  git(mainRoot, ["branch", "-D", assignment.branch]);
  assignment.status = "merged";
  writeJson(paths.assignments, assignments);
  console.log(`Merged ${assignment.branch} into ${assignment.base} and cleaned up the worktree.`);
}

function cmdStatus(mainRoot) {
  const paths = ensureInit(mainRoot);
  const assignments = readJson(paths.assignments, {});
  const claims = readJson(paths.claims, []);
  const messages = readMessages(paths);
  console.log(`Issues (${Object.keys(assignments).length}):`);
  for (const assignment of Object.values(assignments)) {
    console.log(`  ${assignment.issue} · ${assignment.agent} · ${assignment.status} · ${assignment.branch}`);
  }
  console.log(`Claims (${claims.length}):`);
  for (const claim of claims) {
    console.log(`  ${claim.agent} (${claim.issue ?? "-"}): ${claim.paths.join(", ")}`);
  }
  printConflicts(findConflicts(claims));
  console.log(`Messages: ${messages.length} total; last 5:`);
  for (const message of messages.slice(-5)) {
    console.log(`  ${message.ts} ${message.from} ${message.type} ${message.issue ?? "-"}: ${message.body.split("\n")[0].slice(0, 80)}`);
  }
}

function printUsage() {
  console.log(
    [
      "Usage: node collab.mjs <command> [flags]",
      "  init",
      "  assign  --agent <codex|claude> --issue <slug> [--title <text>]",
      "  post    --from <agent> --type <assign|status|question|claim|handoff|review|rebuttal|decision> --body <text> [--issue <slug>] [--refs <csv>]",
      "  inbox   --for <agent> [--peek]",
      "  claim   --agent <agent> --issue <slug> --paths <csv>",
      "  conflicts",
      "  run     --issue <slug> --prompt <text> [--resume [session-id]] [--effort <level>] [--model <model>]",
      "  handoff --issue <slug> [--summary <text>]",
      "  merge   --issue <slug>",
      "  status"
    ].join("\n")
  );
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags } = parseFlags(rest);
  if (!command || command === "help" || flags.help === true) {
    printUsage();
    return;
  }
  const mainRoot = resolveMainRoot(process.cwd());
  switch (command) {
    case "init":
      cmdInit(mainRoot);
      break;
    case "assign":
      cmdAssign(mainRoot, flags);
      break;
    case "post":
      cmdPost(mainRoot, flags);
      break;
    case "inbox":
      cmdInbox(mainRoot, flags);
      break;
    case "claim":
      cmdClaim(mainRoot, flags);
      break;
    case "conflicts":
      cmdConflicts(mainRoot);
      break;
    case "run":
      await cmdRun(mainRoot, flags);
      break;
    case "handoff":
      cmdHandoff(mainRoot, flags);
      break;
    case "merge":
      cmdMerge(mainRoot, flags);
      break;
    case "status":
      cmdStatus(mainRoot);
      break;
    default:
      printUsage();
      fail(`unknown command "${command}"`);
  }
}

main();
