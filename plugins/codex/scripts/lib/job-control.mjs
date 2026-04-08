import fs from "node:fs";

import { getSessionRuntimeStatus } from "./codex.mjs";
import { isProcessAlive } from "./process.mjs";
import { getConfig, listJobs, readJobFile, resolveJobFile, upsertJob, writeJobFile } from "./state.mjs";
import { appendLogLine, SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

function isActiveJob(job) {
  return job.status === "queued" || job.status === "running";
}

function normalizeTrackedPid(pid) {
  const numeric = Number(pid);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

/**
 * Marks a job as failed when its tracked process has died unexpectedly.
 * Re-reads the latest persisted state from disk before writing to guard
 * against races where the job completes legitimately at the same time.
 * @param {string} workspaceRoot
 * @param {string} jobId
 * @param {number} pid - The PID we observed as dead
 * @returns {boolean} true if the job was marked failed, false if skipped
 */
export function markDeadPidJobFailed(workspaceRoot, jobId, pid) {
  const observedPid = normalizeTrackedPid(pid);
  if (observedPid == null) {
    return false;
  }
  const jobFile = resolveJobFile(workspaceRoot, jobId);

  // Re-read the latest persisted state from disk (not from memory)
  let latestJob;
  try {
    latestJob = readJobFile(jobFile);
  } catch {
    return false;
  }

  // Guard 1: only overwrite active states - never downgrade completed/failed
  if (latestJob.status !== "queued" && latestJob.status !== "running") {
    return false;
  }

  // Guard 2: only overwrite if the PID still matches what we observed as dead
  // This prevents overwriting a job that restarted with a new PID
  if (normalizeTrackedPid(latestJob.pid) !== observedPid) {
    return false;
  }

  const completedAt = new Date().toISOString();
  const errorMessage = `Process PID ${observedPid} exited unexpectedly`;

  const failedPatch = {
    status: "failed",
    phase: "failed",
    pid: null,
    errorMessage,
    completedAt
  };

  // Persist to per-job file
  writeJobFile(workspaceRoot, jobId, {
    ...latestJob,
    ...failedPatch
  });
  appendLogLine(latestJob.logFile ?? null, `Failed: ${errorMessage}`);

  // Persist to state index
  upsertJob(workspaceRoot, {
    id: jobId,
    ...failedPatch
  });

  return true;
}

function reconcileDeadPidJob(workspaceRoot, job) {
  const trackedPid = normalizeTrackedPid(job.pid);
  if (!isActiveJob(job) || trackedPid == null) {
    return job;
  }

  if (isProcessAlive(trackedPid)) {
    return job;
  }

  const didFail = markDeadPidJobFailed(workspaceRoot, job.id, trackedPid);
  try {
    const storedJob = readJobFile(resolveJobFile(workspaceRoot, job.id));
    if (didFail) {
      return storedJob;
    }
    if (!isActiveJob(storedJob)) {
      upsertJob(workspaceRoot, {
        id: job.id,
        status: storedJob.status ?? null,
        phase: storedJob.phase ?? null,
        pid: Number.isFinite(storedJob.pid) ? storedJob.pid : null,
        completedAt: storedJob.completedAt ?? null,
        errorMessage: storedJob.errorMessage ?? null,
        threadId: storedJob.threadId ?? null,
        turnId: storedJob.turnId ?? null,
        summary: storedJob.summary ?? job.summary ?? null
      });
      return {
        ...job,
        ...storedJob
      };
    }
    return job;
  } catch {
    return job;
  }
}

function reconcileDeadPidJobs(workspaceRoot, jobs) {
  return jobs.map((job) => reconcileDeadPidJob(workspaceRoot, job));
}

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting codex") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("codex error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run /codex:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(reconcileDeadPidJobs(workspaceRoot, filterJobsForCurrentSession(listJobs(workspaceRoot), options)));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => isActiveJob(job))
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => !isActiveJob(job)) ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => !isActiveJob(job) && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reconcileDeadPidJobs(workspaceRoot, listJobs(workspaceRoot)));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /codex:status to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(
    reconcileDeadPidJobs(workspaceRoot, reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)))
  );
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => !isActiveJob(job)
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, (job) => isActiveJob(job));
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /codex:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /codex:status to inspect active jobs.`);
  }

  throw new Error("No finished Codex jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reconcileDeadPidJobs(workspaceRoot, listJobs(workspaceRoot)));
  const activeJobs = jobs.filter((job) => isActiveJob(job));

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple Codex jobs are active. Pass a job id to /codex:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Codex jobs to cancel for this session.");
  }

  throw new Error("No active Codex jobs to cancel.");
}
