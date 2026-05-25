#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import os from "node:os";

// ── Model registry ──────────────────────────────────────────────────────────

const MODELS = {
  doubao: {
    bin: "cc-doubao",
    label: "Doubao (doubao-seed-code-preview-latest)",
    desc: "Seed Code Preview / router / Seed 2.0",
    profileEnv: "DOUBAO_PROFILE",
    profiles: ["latest", "agent", "vision", "frontend", "pinned", "router", "seed20", "reasoning", "cheap"],
  },
  qwen: {
    bin: "cc-qwen",
    label: "Qwen (qwen3-coder-next; opus→qwen3-coder-plus)",
    desc: "Coder / Coding Plan / Token Plan / PayG",
    profileEnv: "QWEN_PROFILE",
    profiles: ["coder", "coding-plan", "plan", "token", "token-plan", "payg", "intl", "max", "cheap", "flash"],
  },
  kimi: {
    bin: "cc-kimi",
    label: "Kimi (kimi-for-coding)",
    desc: "stable Kimi Code route, 64K out",
    profiles: [],
  },
  glm: {
    bin: "cc-glm",
    label: "GLM (glm-4.7; opus→glm-5.1)",
    desc: "Z.ai Claude Code route, thinking auto on max/turbo",
    profileEnv: "GLM_PROFILE",
    profiles: ["balanced", "max", "opus", "turbo", "cheap", "lite"],
  },
  stepfun: {
    bin: "cc-stepfun",
    label: "StepFun (step-3.5-flash-2603)",
    desc: "Step Plan reasoning / flash / router",
    profileEnv: "STEPFUN_PROFILE",
    profiles: ["reasoning", "fast", "flash", "router"],
  },
  minimax: {
    bin: "cc-minimax",
    label: "MiniMax (MiniMax-M2.7)",
    desc: "M2 stable / highspeed / cheap, 64K Anthropic output",
    profileEnv: "MINIMAX_PROFILE",
    profiles: ["stable", "token", "highspeed", "payg", "cheap", "lite"],
  },
  mimo: {
    bin: "cc-mimo",
    label: "MiMo (mimo-v2-pro)",
    desc: "token-plan Pro / V2.5 / Omni / Flash",
    profileEnv: "MIMO_PROFILE",
    profiles: ["pro", "latest", "v25", "multimodal", "omni", "fast", "flash"],
  },
};

const MODEL_NAMES = Object.keys(MODELS);
const DEFAULT_MODEL = "doubao";
// Default fan-out pool when `team` is called without --models/--all.
// Complementary by design: coder (qwen) · Chinese reasoning (glm) · long-context (kimi).
const DEFAULT_TEAM = ["qwen", "glm", "kimi"];
const TASK_TIMEOUT_MS = 300_000; // 5 min

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolveBin(name) {
  return path.join(os.homedir(), "bin", MODELS[name].bin);
}

function envForModel(name, profile) {
  const info = MODELS[name];
  const env = { ...process.env };
  if (profile && info.profileEnv) {
    env[info.profileEnv] = profile;
  }
  return env;
}

function assertProfile(name, profile) {
  if (!profile) return;
  const profiles = MODELS[name].profiles ?? [];
  if (profiles.length > 0 && !profiles.includes(profile)) {
    throw new Error(`Unknown profile "${profile}" for ${name}. Available: ${profiles.join(", ")}`);
  }
  if (profiles.length === 0) {
    throw new Error(`${name} does not expose profile switching. Use its model-specific env vars instead.`);
  }
}

function parseBoolFlags(argv, flagNames) {
  const values = Object.fromEntries(flagNames.map((name) => [name, false]));
  for (const arg of argv) {
    if (flagNames.includes(arg)) values[arg] = true;
  }
  return values;
}

function parseValueOption(argv, name) {
  const inlinePrefix = `${name}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === name) return argv[i + 1] ?? "";
    if (arg.startsWith(inlinePrefix)) return arg.slice(inlinePrefix.length);
  }
  return "";
}

function parseTaskArgs(argv) {
  const opts = {
    asJson: false,
    dangerously: false,
    dryRun: false,
    modelName: DEFAULT_MODEL,
    profile: "",
    cwd: process.cwd(),
    timeout: TASK_TIMEOUT_MS,
    prompt: "",
  };
  const promptParts = [];
  let parsingOptions = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (parsingOptions && arg === "--") {
      promptParts.push(...argv.slice(i + 1));
      break;
    }

    if (parsingOptions && arg === "--json") {
      opts.asJson = true;
      continue;
    }
    if (parsingOptions && arg === "--dangerously-skip-permissions") {
      opts.dangerously = true;
      continue;
    }
    if (parsingOptions && arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }

    if (parsingOptions && (arg === "--model" || arg.startsWith("--model="))) {
      const value = arg.includes("=") ? arg.slice("--model=".length) : argv[++i];
      opts.modelName = (value || "").toLowerCase();
      continue;
    }
    if (parsingOptions && (arg === "--profile" || arg.startsWith("--profile="))) {
      const value = arg.includes("=") ? arg.slice("--profile=".length) : argv[++i];
      opts.profile = (value || "").toLowerCase();
      continue;
    }
    if (parsingOptions && (arg === "--cwd" || arg.startsWith("--cwd="))) {
      const value = arg.includes("=") ? arg.slice("--cwd=".length) : argv[++i];
      opts.cwd = path.resolve(value || process.cwd());
      continue;
    }
    if (parsingOptions && (arg === "--timeout" || arg.startsWith("--timeout="))) {
      const value = arg.includes("=") ? arg.slice("--timeout=".length) : argv[++i];
      const seconds = Number.parseInt(value || "", 10);
      if (Number.isFinite(seconds) && seconds > 0) {
        opts.timeout = seconds * 1000;
      }
      continue;
    }

    parsingOptions = false;
    promptParts.push(arg);
  }

  opts.prompt = promptParts.join(" ").trim();
  return opts;
}

// Parse a comma-separated member spec like "qwen:token,glm:max,kimi"
// into [{ name, profile }]. Bare entries get an empty profile.
function parseModelsSpec(spec) {
  return String(spec || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(":");
      const name = (idx === -1 ? entry : entry.slice(0, idx)).toLowerCase();
      const profile = (idx === -1 ? "" : entry.slice(idx + 1)).toLowerCase();
      return { name, profile };
    });
}

function parseTeamArgs(argv) {
  const opts = {
    asJson: false,
    dangerously: false,
    dryRun: false,
    all: false,
    modelsSpec: "",
    cwd: process.cwd(),
    timeout: TASK_TIMEOUT_MS,
    prompt: "",
  };
  const promptParts = [];
  let parsingOptions = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (parsingOptions && arg === "--") {
      promptParts.push(...argv.slice(i + 1));
      break;
    }

    if (parsingOptions && arg === "--json") {
      opts.asJson = true;
      continue;
    }
    if (parsingOptions && arg === "--dangerously-skip-permissions") {
      opts.dangerously = true;
      continue;
    }
    if (parsingOptions && arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (parsingOptions && arg === "--all") {
      opts.all = true;
      continue;
    }

    if (parsingOptions && (arg === "--models" || arg.startsWith("--models="))) {
      const value = arg.includes("=") ? arg.slice("--models=".length) : argv[++i];
      opts.modelsSpec = value || "";
      continue;
    }
    if (parsingOptions && (arg === "--cwd" || arg.startsWith("--cwd="))) {
      const value = arg.includes("=") ? arg.slice("--cwd=".length) : argv[++i];
      opts.cwd = path.resolve(value || process.cwd());
      continue;
    }
    if (parsingOptions && (arg === "--timeout" || arg.startsWith("--timeout="))) {
      const value = arg.includes("=") ? arg.slice("--timeout=".length) : argv[++i];
      const seconds = Number.parseInt(value || "", 10);
      if (Number.isFinite(seconds) && seconds > 0) {
        opts.timeout = seconds * 1000;
      }
      continue;
    }

    parsingOptions = false;
    promptParts.push(arg);
  }

  opts.prompt = promptParts.join(" ").trim();

  let requested;
  if (opts.all) {
    requested = MODEL_NAMES.map((name) => ({ name, profile: "" }));
  } else if (opts.modelsSpec) {
    requested = parseModelsSpec(opts.modelsSpec);
  } else {
    requested = DEFAULT_TEAM.map((name) => ({ name, profile: "" }));
  }

  // De-duplicate by name+profile while preserving order.
  const seen = new Set();
  opts.members = [];
  for (const member of requested) {
    const key = `${member.name}:${member.profile}`;
    if (!seen.has(key)) {
      seen.add(key);
      opts.members.push(member);
    }
  }

  return opts;
}

function pingModel(name, opts = {}) {
  const bin = MODELS[name].bin;
  const args = opts.doctor ? ["--doctor"] : ["--version"];
  const result = spawnSync(bin, args, {
    timeout: 10_000,
    env: envForModel(name, opts.profile),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) {
    const version = (result.stdout ?? "").toString().trim();
    return { available: true, detail: version };
  }
  const err = (result.stderr ?? "").toString().trim() || result.error?.message || "unknown error";
  return { available: false, detail: err };
}

function runTask(modelName, prompt, opts = {}) {
  return new Promise((resolve, reject) => {
    const bin = resolveBin(modelName);
    const args = ["-p", prompt, "--max-turns", "1"];
    if (opts.dangerously) args.push("--dangerously-skip-permissions");

    const child = spawn(bin, args, {
      cwd: opts.cwd || process.cwd(),
      env: envForModel(modelName, opts.profile),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeout || TASK_TIMEOUT_MS,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Task timed out after ${(opts.timeout || TASK_TIMEOUT_MS) / 1000}s`));
    }, opts.timeout || TASK_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, model: modelName });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Commands ────────────────────────────────────────────────────────────────

async function handleSetup(argv) {
  const flags = parseBoolFlags(argv, ["--json", "--doctor"]);
  const asJson = flags["--json"];
  const useDoctor = flags["--doctor"];
  const results = {};
  for (const name of MODEL_NAMES) {
    results[name] = {
      ...MODELS[name],
      ...pingModel(name, { doctor: useDoctor }),
    };
  }

  const readyCount = Object.values(results).filter((r) => r.available).length;

  if (asJson) {
    console.log(JSON.stringify({ ready: readyCount, total: MODEL_NAMES.length, models: results }, null, 2));
  } else {
      console.log(`CN Models Setup — ${readyCount}/${MODEL_NAMES.length} available\n`);
    for (const [name, info] of Object.entries(results)) {
      const icon = info.available ? "✓" : "✗";
      const profiles = info.profiles?.length ? ` profiles: ${info.profiles.join("/")}` : " profiles: env-only";
      console.log(`  ${icon} ${name.padEnd(8)} ${info.label.padEnd(52)} ${info.available ? info.detail : `(${info.detail})`}`);
      console.log(`    ${profiles}`);
    }
    if (readyCount < MODEL_NAMES.length) {
      console.log(`\nSome models unavailable. Check ~/bin/cc-* scripts and API keys.`);
    }
  }
}

async function handleTask(argv) {
  const { asJson, dangerously, dryRun, modelName, profile, cwd, timeout, prompt } = parseTaskArgs(argv);
  if (!MODELS[modelName]) {
    const msg = `Unknown model "${modelName}". Available: ${MODEL_NAMES.join(", ")}`;
    if (asJson) { console.log(JSON.stringify({ error: msg })); } else { console.error(msg); }
    process.exitCode = 1;
    return;
  }
  try {
    assertProfile(modelName, profile);
  } catch (err) {
    const msg = err.message || String(err);
    if (asJson) { console.log(JSON.stringify({ error: msg })); } else { console.error(msg); }
    process.exitCode = 1;
    return;
  }

  if (!prompt) {
    const msg = "No prompt provided.";
    if (asJson) { console.log(JSON.stringify({ error: msg })); } else { console.error(msg); }
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    const info = {
      model: modelName,
      profile: profile || null,
      profileEnv: MODELS[modelName].profileEnv ?? null,
      cwd,
      timeoutMs: timeout,
      dangerously,
      prompt,
    };
    if (asJson) {
      console.log(JSON.stringify(info, null, 2));
    } else {
      console.log(`model=${info.model}`);
      console.log(`profile=${info.profile ?? ""}`);
      console.log(`cwd=${info.cwd}`);
      console.log(`timeoutMs=${info.timeoutMs}`);
      console.log(`dangerously=${info.dangerously}`);
      console.log(`prompt=${info.prompt}`);
    }
    return;
  }

  // Check availability
  const check = pingModel(modelName, { profile });
  if (!check.available) {
    const msg = `Model ${modelName} is not available: ${check.detail}. Run /cn:setup to check.`;
    if (asJson) { console.log(JSON.stringify({ error: msg })); } else { console.error(msg); }
    process.exitCode = 1;
    return;
  }

  // Execute
  if (!asJson) {
    const profileText = profile ? ` profile=${profile}` : "";
    process.stderr.write(`[cn] Dispatching to ${modelName}${profileText} (${MODELS[modelName].desc})...\n`);
  }

  try {
    const result = await runTask(modelName, prompt, { cwd, timeout, dangerously, profile });

    if (asJson) {
      console.log(JSON.stringify({
        model: modelName,
        profile: profile || null,
        label: MODELS[modelName].label,
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      }, null, 2));
    } else {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.code !== 0 && result.stderr) {
        process.stderr.write(`\n[cn] ${modelName} exited with code ${result.code}\n`);
        process.stderr.write(result.stderr.slice(0, 500));
      }
    }

    if (result.code !== 0) process.exitCode = result.code;
  } catch (err) {
    const msg = err.message || String(err);
    if (asJson) { console.log(JSON.stringify({ error: msg })); } else { console.error(`[cn] Error: ${msg}`); }
    process.exitCode = 1;
  }
}

async function handleTeam(argv) {
  const { asJson, dangerously, dryRun, cwd, timeout, prompt, members } = parseTeamArgs(argv);

  const fail = (msg) => {
    if (asJson) { console.log(JSON.stringify({ error: msg })); } else { console.error(msg); }
    process.exitCode = 1;
  };

  if (members.length === 0) {
    fail("No models selected. Use --models <a,b:profile,c>, --all, or rely on the default team.");
    return;
  }

  // Validate every member (model name + profile) before running anything.
  for (const member of members) {
    if (!MODELS[member.name]) {
      fail(`Unknown model "${member.name}". Available: ${MODEL_NAMES.join(", ")}`);
      return;
    }
    try {
      assertProfile(member.name, member.profile);
    } catch (err) {
      fail(err.message || String(err));
      return;
    }
  }

  if (!prompt) {
    fail("No prompt provided.");
    return;
  }

  const tag = (member) => (member.profile ? `${member.name}:${member.profile}` : member.name);

  if (dryRun) {
    const info = {
      command: "team",
      members: members.map((m) => ({ model: m.name, profile: m.profile || null })),
      cwd,
      timeoutMs: timeout,
      dangerously,
      prompt,
    };
    if (asJson) {
      console.log(JSON.stringify(info, null, 2));
    } else {
      console.log(`members=${members.map(tag).join(",")}`);
      console.log(`cwd=${cwd}`);
      console.log(`timeoutMs=${timeout}`);
      console.log(`dangerously=${dangerously}`);
      console.log(`prompt=${prompt}`);
    }
    return;
  }

  // Availability check up front so one offline backend does not abort the rest.
  const checks = members.map((m) => ({ ...m, ...pingModel(m.name, { profile: m.profile }) }));
  const available = checks.filter((m) => m.available);
  const unavailable = checks.filter((m) => !m.available);

  if (available.length === 0) {
    fail(
      `No selected models are available: ${unavailable
        .map((m) => `${m.name} (${m.detail})`)
        .join("; ")}. Run /cn:setup to check.`
    );
    return;
  }

  if (!asJson) {
    process.stderr.write(`[cn:team] Fanning out to ${available.length} model(s): ${available.map(tag).join(", ")}...\n`);
    if (unavailable.length > 0) {
      process.stderr.write(`[cn:team] Skipping unavailable: ${unavailable.map((m) => m.name).join(", ")}\n`);
    }
  }

  // Fan out in parallel; allSettled so a single failure never sinks the batch.
  const settled = await Promise.allSettled(
    available.map((m) => runTask(m.name, prompt, { cwd, timeout, dangerously, profile: m.profile }))
  );

  const results = available.map((m, idx) => {
    const outcome = settled[idx];
    if (outcome.status === "fulfilled") {
      return {
        model: m.name,
        profile: m.profile || null,
        label: MODELS[m.name].label,
        ok: outcome.value.code === 0,
        exitCode: outcome.value.code,
        stdout: outcome.value.stdout,
        stderr: outcome.value.stderr,
      };
    }
    return {
      model: m.name,
      profile: m.profile || null,
      label: MODELS[m.name].label,
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: outcome.reason?.message || String(outcome.reason),
    };
  });

  const skipped = unavailable.map((m) => ({
    model: m.name,
    profile: m.profile || null,
    label: MODELS[m.name].label,
    ok: false,
    skipped: true,
    detail: m.detail,
  }));

  const okCount = results.filter((r) => r.ok).length;

  if (asJson) {
    console.log(JSON.stringify({
      command: "team",
      prompt,
      okCount,
      ran: results.length,
      skipped: skipped.length,
      results,
      skippedModels: skipped,
    }, null, 2));
  } else {
    for (const r of results) {
      const label = r.profile ? `${r.model}:${r.profile}` : r.model;
      console.log(`\n===== [cn:${label}] exit=${r.exitCode} =====`);
      if (r.stdout) process.stdout.write(r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
      if (!r.ok && r.stderr) process.stderr.write(`[cn:${label}] ${r.stderr.slice(0, 500)}\n`);
    }
    for (const s of skipped) {
      console.log(`\n===== [cn:${s.model}] skipped (unavailable) =====`);
      console.log(`  ${s.detail}`);
    }
    const skipNote = skipped.length ? `, ${skipped.length} skipped` : "";
    console.log(`\n[cn:team] ${okCount}/${results.length} model(s) succeeded${skipNote}. Review and synthesize the outputs above.`);
  }

  if (okCount === 0) process.exitCode = 1;
}

function handlePing(argv) {
  const modelName = (argv[0] || "").toLowerCase();
  if (!modelName || !MODELS[modelName]) {
    console.error(`Usage: cn-companion.mjs ping <${MODEL_NAMES.join("|")}>`);
    process.exitCode = 1;
    return;
  }
  const profile = (parseValueOption(argv, "--profile") || "").toLowerCase();
  try {
    assertProfile(modelName, profile);
  } catch (err) {
    console.error(err.message || String(err));
    process.exitCode = 1;
    return;
  }
  const result = pingModel(modelName, { profile });
  console.log(JSON.stringify({ model: modelName, profile: profile || null, ...result }, null, 2));
}

function handleProfiles() {
  for (const [name, info] of Object.entries(MODELS)) {
    const profileText = info.profiles.length > 0 ? info.profiles.join(", ") : "(no profile env)";
    console.log(`${name.padEnd(8)} ${info.profileEnv ?? "-"} ${profileText}`);
  }
}

function printUsage() {
  console.log([
    "Usage:",
    "  node cn-companion.mjs setup [--json] [--doctor]",
    "  node cn-companion.mjs task --model <name> [--profile <profile>] [--timeout <sec>] [--cwd <dir>] [--json] [--dry-run] [--] <prompt>",
    "  node cn-companion.mjs team [--models <a,b:profile,c>] [--all] [--timeout <sec>] [--cwd <dir>] [--json] [--dry-run] [--] <prompt>",
    "  node cn-companion.mjs ping <model-name> [--profile <profile>]",
    "  node cn-companion.mjs profiles",
    "",
    `Available models: ${MODEL_NAMES.join(", ")}`,
    `Default team:     ${DEFAULT_TEAM.join(", ")}`,
  ].join("\n"));
}

// ── Main ────────────────────────────────────────────────────────────────────

const [subcommand, ...argv] = process.argv.slice(2);

switch (subcommand) {
  case "setup":
    await handleSetup(argv);
    break;
  case "task":
    await handleTask(argv);
    break;
  case "team":
    await handleTeam(argv);
    break;
  case "ping":
    handlePing(argv);
    break;
  case "profiles":
    handleProfiles();
    break;
  case "help":
  case "--help":
  case undefined:
    printUsage();
    break;
  default:
    console.error(`Unknown subcommand: ${subcommand}`);
    printUsage();
    process.exitCode = 1;
}
