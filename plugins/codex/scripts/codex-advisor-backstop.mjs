#!/usr/bin/env node
// Stop-hook backstop for the Codex second-opinion advisor (fork addition).
// Guarantees: if the built-in `advisor` ran in this session and no `codex-advisor`
// run followed it, block the stop and force the agent to run it. Loop-safe: once the
// codex-advisor command appears in the transcript (success OR skip), it allows the stop.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// codex-advisor.mjs lives next to this script wherever the plugin is materialized.
const ADVISOR_PATH = join(dirname(fileURLToPath(import.meta.url)), 'codex-advisor.mjs');

const allow = () => process.exit(0);
const block = (reason) => {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
};

let input;
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { allow(); }
const tpath = input.transcript_path;
if (!tpath) allow();

let lines;
try { lines = readFileSync(tpath, 'utf8').split('\n').filter(Boolean); } catch { allow(); }

const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });

// index of the most recent built-in advisor result
let lastAdvisorIdx = -1;
for (let i = 0; i < parsed.length; i++) {
  const c = parsed[i]?.message?.content;
  if (parsed[i]?.type === 'assistant' && Array.isArray(c) && c.some((b) => b.type === 'advisor_tool_result')) {
    lastAdvisorIdx = i;
  }
}
if (lastAdvisorIdx === -1) allow(); // no advisor used this session

// Did a codex-advisor run actually PRODUCE output after the latest advisor result?
// Evidence = a tool_result carrying the second-opinion banner, or the "[codex-advisor]"
// skip/error prefix (skips count as compliance per the operating rule). A Bash command
// merely MENTIONING codex-advisor is NOT evidence — that hole let failed or wrong-path
// attempts satisfy this gate.
const textOf = (c) => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((x) => (x && x.text) || '').join('\n')
  : c ? JSON.stringify(c) : '';
for (let i = lastAdvisorIdx + 1; i < parsed.length; i++) {
  const c = parsed[i]?.message?.content;
  if (!Array.isArray(c)) continue;
  for (const b of c) {
    if (b.type === 'tool_result') {
      const t = textOf(b.content);
      if (t.includes('SECOND OPINION (codex-advisor') || t.includes('[codex-advisor]')) allow();
    }
  }
}

// already forced once and still not run -> give up rather than trap the session
if (input.stop_hook_active) allow();

block(`A built-in advisor() opinion was given but the required Codex second opinion has not run yet. Run \`node ${ADVISOR_PATH}\` once now (use a Bash timeout of ~300000ms), then weigh its GPT second opinion before finishing.`);
