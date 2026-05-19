import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  fs.writeFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

// POSIX guarantees `write(fd, buf, n)` with O_APPEND is atomic when `n` is
// less than PIPE_BUF (typically 4096 on Linux/macOS). Keep one NDJSON line
// at or below this bound so a concurrent reader can never observe a partial
// event. Writers truncate the `raw` field (or elide it entirely) to fit.
const MAX_EVENT_LINE_BYTES = 4096;

export function resolveJobEventsFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.events.ndjson`);
}

export function appendJobEvent(cwd, jobId, event) {
  const eventsFile = resolveJobEventsFile(cwd, jobId);
  let line = `${JSON.stringify(event)}\n`;

  if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES && event.raw != null) {
    const summary =
      event.raw && typeof event.raw === "object"
        ? Object.keys(event.raw).slice(0, 8).join(",")
        : String(event.raw).slice(0, 100);
    const truncated = { ...event, raw: { truncated: true, summary } };
    line = `${JSON.stringify(truncated)}\n`;
  }

  if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
    const elided = {
      seq: event.seq,
      ts: event.ts,
      type: "oversize-event-elided",
      method: event.method ?? null,
      phase: event.phase ?? null
    };
    line = `${JSON.stringify(elided)}\n`;
  }

  fs.appendFileSync(eventsFile, line, "utf8");
}

export function readJobEvents(cwd, jobId, options = {}) {
  const { since = null, afterSeq = null, limit = null } = options;
  const eventsFile = resolveJobEventsFile(cwd, jobId);
  if (!fs.existsSync(eventsFile)) {
    return [];
  }

  const content = fs.readFileSync(eventsFile, "utf8");
  const lines = content.split("\n");
  const lastIndex = lines.length - 1;
  const events = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Tolerate a partial last line: writer may be mid-write between
      // assembling the JSON and writing the trailing newline. Drop it; the
      // next read picks it up. For any non-trailing parse failure, treat as
      // skipped corruption (rare; we'd see it again on next read).
      if (i === lastIndex || (i === lastIndex - 1 && lines[lastIndex] === "")) {
        continue;
      }
      continue;
    }
  }

  let filtered = events;
  if (afterSeq != null) {
    filtered = filtered.filter((event) => typeof event.seq === "number" && event.seq > afterSeq);
  } else if (since != null) {
    filtered = filtered.filter((event) => typeof event.ts === "string" && event.ts > since);
  }
  if (limit != null && Number.isFinite(limit)) {
    filtered = filtered.slice(0, limit);
  }
  return filtered;
}
