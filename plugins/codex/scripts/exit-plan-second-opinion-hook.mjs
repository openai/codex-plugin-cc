#!/usr/bin/env node
// PostToolUse(ExitPlanMode) hook — decoupled second-opinion trigger (fork addition).
// The built-in advisor never fires on Fable 5 mains (Fable-as-advisor is server-gated),
// so plan approval is the moment that gets an independent GPT review: feed the approved
// plan to codex-advisor.mjs and return its opinion as additionalContext. Non-fatal
// everywhere — a broken or slow codex must never block the plan flow (always exit 0).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADVISOR = join(dirname(fileURLToPath(import.meta.url)), 'codex-advisor.mjs');
const quit = () => process.exit(0);

let input;
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { quit(); }
const plan = input?.tool_input?.plan;
if (!plan || typeof plan !== 'string' || !plan.trim()) quit();
// A rejected plan means Claude keeps planning — don't spend a codex run on it.
if (/reject|not approved|denied/i.test(JSON.stringify(input.tool_response ?? ''))) quit();

const PLAN_DIR = join(homedir(), '.claude', 'cache', 'codex-advisor', 'plans');
const planPath = join(PLAN_DIR, `${createHash('sha1').update(plan).digest('hex').slice(0, 16)}.md`);
try { mkdirSync(PLAN_DIR, { recursive: true }); writeFileSync(planPath, plan); } catch { quit(); }

const args = [ADVISOR, '--plan-file', planPath];
if (input.transcript_path) args.push('--transcript', input.transcript_path);
const r = spawnSync('node', args, {
  cwd: input.cwd || process.cwd(),
  encoding: 'utf8',
  timeout: 450_000,
  env: { ...process.env, CLAUDE_CODE_SESSION_ID: input.session_id || process.env.CLAUDE_CODE_SESSION_ID || '' },
  maxBuffer: 16 * 1024 * 1024,
});
const out = (r.stdout || '').trim();
// Dedup/skip paths ("[codex-advisor] … skipping.") add nothing — stay silent.
if (!out || out.includes('skipping.')) quit();
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: `Codex (GPT) second opinion on the approved plan — weigh it before executing:\n\n${out}`,
  },
}));
quit();
