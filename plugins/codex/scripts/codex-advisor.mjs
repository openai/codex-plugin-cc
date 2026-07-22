#!/usr/bin/env node
// codex-advisor — second opinion after Claude Code's built-in `advisor` tool.
// Reconstructs the FULL session transcript (true parity with what the advisor saw)
// plus the advisor's verdict, sends it to GPT via `codex exec`, and prints
// Codex's independent second opinion to stdout. Non-fatal on any failure (exit 0).
//
// Env overrides: CODEX_ADVISOR_MODEL (default gpt-5.6-sol), CODEX_ADVISOR_EFFORT (default high).
// Arg override:  --transcript <path>  to point at a specific session jsonl.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const PROJECTS = join(HOME, '.claude', 'projects');
// Live run logs — the canonical persistent location (one <runId> subdir per run). Never /tmp.
const LOGS_ROOT = join(HOME, '.claude', 'logs', 'codex-advisor');
const MODEL = process.env.CODEX_ADVISOR_MODEL || 'gpt-5.6-sol';
const EFFORT = process.env.CODEX_ADVISOR_EFFORT || 'high';

const argVal = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
};
const done = (msg) => { console.log(msg); process.exit(0); };

// --- locate the current session transcript (newest jsonl; cwd-encoded dir first) ---
function findTranscript() {
  const override = argVal('--transcript');
  if (override) return override;
  // Deterministic: the CURRENT session id is in the environment. Its transcript is
  // <projects>/<enc-cwd>/<sid>.jsonl. Session ids are globally unique, so scan project
  // dirs for that exact file (sidesteps cwd-encoding mismatch). This avoids the
  // cross-session bleed that picking the globally-newest mtime caused when multiple
  // Claude sessions were open at once.
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  if (sid) {
    try {
      for (const d of readdirSync(PROJECTS)) {
        const p = join(PROJECTS, d, `${sid}.jsonl`);
        if (existsSync(p)) return p;
      }
    } catch {}
  }
  // Fallback (no session id): newest jsonl in THIS cwd's project dir ONLY — never across
  // all projects.
  const enc = process.cwd().replace(/\//g, '-');
  let found = [];
  try {
    found = readdirSync(join(PROJECTS, enc))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => { const p = join(PROJECTS, enc, f); return [p, statSync(p).mtimeMs]; });
  } catch {}
  if (!found.length) return null;
  found.sort((a, b) => b[1] - a[1]);
  return found[0][0];
}

// --- reconstruct conversation (full parity) + capture latest advisor verdict ---
function reconstruct(path) {
  const out = [];
  let verdict = null;
  let verdictId = null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if ((o.type !== 'user' && o.type !== 'assistant') || !o.message) continue;
    const content = o.message.content;
    if (typeof content === 'string') { out.push(`### ${o.type.toUpperCase()}\n${content}`); continue; }
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      switch (b.type) {
        case 'text': out.push(`### ${o.type.toUpperCase()}\n${b.text}`); break;
        case 'thinking': out.push(`### ASSISTANT (reasoning trace)\n${b.thinking || b.text || ''}`); break;
        case 'tool_use': out.push(`### TOOL CALL: ${b.name}\n${JSON.stringify(b.input)}`); break;
        case 'server_tool_use': out.push(`### SERVER TOOL CALL: ${b.name}`); break;
        case 'tool_result': {
          const c = b.content;
          const txt = typeof c === 'string' ? c
            : Array.isArray(c) ? c.map((x) => x.text || '').join('\n')
            : JSON.stringify(c);
          out.push(`### TOOL RESULT\n${txt}`);
          break;
        }
        case 'advisor_tool_result':
          verdict = (b.content && b.content.text) || null;
          verdictId = b.tool_use_id || verdictId;
          out.push(`### CLAUDE ADVISOR VERDICT (inline — context only; the verdict to review is appended at the end)\n${verdict || ''}`);
          break;
      }
    }
  }
  return { transcript: out.join('\n\n'), verdict, verdictId };
}

const path = findTranscript();
if (!path) done('[codex-advisor] no transcript found; skipping.');
const { transcript, verdict, verdictId } = reconstruct(path);
if (!verdict) done('[codex-advisor] no advisor verdict in transcript; skipping.');

// Dedup: exactly one Codex opinion per advisor verdict. A second invocation for the same
// verdict — e.g. a council sub-agent, which SHARES this session's CLAUDE_CODE_SESSION_ID —
// skips. The main agent runs first (right after advisor()), so it wins the marker and
// sub-agents skip. CODEX_ADVISOR_FORCE=1 bypasses (for testing).
const MARKER_DIR = join(HOME, '.claude', 'cache', 'codex-advisor');
const markerPath = join(MARKER_DIR, `${(verdictId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
if (!process.env.CODEX_ADVISOR_FORCE && verdictId && existsSync(markerPath)) {
  done('[codex-advisor] a second opinion already ran for this advisor verdict; skipping.');
}
try {
  mkdirSync(MARKER_DIR, { recursive: true });
  writeFileSync(markerPath, JSON.stringify({ sid: process.env.CLAUDE_CODE_SESSION_ID || null, verdictId, transcript: path, ts: new Date().toISOString() }));
} catch {}

const prompt = [
  'You are GPT-5.5 acting as a SECOND ADVISOR. Below is the FULL session a first (Claude) advisor reviewed — every user/assistant message, the assistant\'s REASONING TRACE, and every tool call and result. The session is CONTEXT. The Claude advisor verdict you must give a second opinion on is the SINGLE block appended at the very end (the MOST RECENT verdict); any earlier "CLAUDE ADVISOR VERDICT" blocks appearing inline within the session are context only — do not review those. Give an INDEPENDENT second opinion on that most-recent verdict.',
  '',
  'Specifically:',
  '1) Where you AGREE or DISAGREE with the Claude advisor, and why. Be concrete.',
  '2) REASONING-TRACE AUDIT: scrutinize the assistant\'s reasoning blocks and explicitly flag any logical flaws, invalid inferences, unjustified leaps, or factual errors. Quote the specific step.',
  '3) Anything important BOTH the assistant and the Claude advisor missed.',
  'Be direct and concise. Do not restate the session back to me.',
  '',
  '================ FULL SESSION ================',
  transcript,
  '================ END SESSION ================',
  '',
  '================ THE ADVISOR VERDICT TO REVIEW (most recent — your second opinion is about THIS) ================',
  verdict,
  '================ END VERDICT ================',
].join('\n');

// Persistent run log: ~/.claude/logs/codex-advisor/<runId>/ (runId = UTC ts + short session id).
const ts = new Date().toISOString();
const runId = `${ts.replace(/:/g, '-').replace(/\.\d+Z$/, 'Z')}__${(process.env.CLAUDE_CODE_SESSION_ID || 'nosid').slice(0, 8)}`;
const LOG_DIR = join(LOGS_ROOT, runId);
mkdirSync(LOG_DIR, { recursive: true });
const writeMeta = (status) => {
  try {
    writeFileSync(join(LOG_DIR, 'meta.json'), JSON.stringify({
      session_id: process.env.CLAUDE_CODE_SESSION_ID || null,
      resolved_transcript_path: path,
      verdict_id: verdictId,
      model: MODEL,
      effort: EFFORT,
      ts,
      status,
    }, null, 2));
  } catch {}
};
try { writeFileSync(join(LOG_DIR, 'prompt.txt'), prompt); } catch {}

const outFile = join(LOG_DIR, 'output.txt');
const r = spawnSync('codex', [
  'exec', '--skip-git-repo-check', '-m', MODEL, '-s', 'read-only',
  '-c', `model_reasoning_effort=${EFFORT}`,
  '-o', outFile, '-',
], { input: prompt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

if (r.error) { writeMeta('codex-error'); done(`[codex-advisor] codex unavailable: ${r.error.message}\n[codex-advisor] log: ${LOG_DIR}`); }
let answer = '';
try { answer = readFileSync(outFile, 'utf8').trim(); } catch {}
if (!answer) answer = (r.stdout || '').trim();
if (!answer) { writeMeta('no-output'); done(`[codex-advisor] codex produced no output (exit ${r.status}). ${(r.stderr || '').slice(-400)}\n[codex-advisor] log: ${LOG_DIR}`); }

console.log(`===== GPT-5.5 SECOND OPINION (codex-advisor · effort=${EFFORT}) =====\n`);
console.log(answer);
writeMeta('ok');
console.log(`\n[codex-advisor] log: ${LOG_DIR}`);
