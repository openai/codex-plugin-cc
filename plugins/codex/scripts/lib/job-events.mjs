import { setTimeout } from "node:timers/promises";
import { buildStatusSnapshot, checkJobLiveness, DEFAULT_STALL_MS, lastJobProgressAt, readStoredJob } from "./job-control.mjs";
import { acknowledgeNotifications, liveStatus } from "./live-commands.mjs";

function oneLine(text) {
  return String(text ?? "").replace(/[\r\n]+/g, " ");
}

export async function streamJobEvents(cwd, { pollMs = 2000, stallMs = DEFAULT_STALL_MS, signal } = {}, dependencies = {}) {
  const snapshot = dependencies.snapshot ?? buildStatusSnapshot;
  const status = dependencies.status ?? liveStatus;
  const acknowledge = dependencies.acknowledge ?? acknowledgeNotifications;
  const readJob = dependencies.readJob ?? readStoredJob;
  const writeLine = dependencies.writeLine ?? ((line) => process.stdout.write(`${line}\n`));
  const now = dependencies.now ?? Date.now;
  const progressAt = dependencies.progressAt ?? lastJobProgressAt;
  const active = new Set();
  const questions = new Set();
  const notifications = new Set();
  const brokerFailures = new Map();
  const stalls = new Map();
  while (!signal?.aborted) {
    const report = snapshot(cwd, { all: true });
    for (let job of [...report.running, report.latestFinished, ...report.recent].filter(Boolean)) {
      if (signal?.aborted) break;
      let running = job.status === "queued" || job.status === "running";
      if (running) active.add(job.id);
      if (!active.has(job.id)) continue;
      let live = await status(cwd, job);
      if (signal?.aborted) continue;
      job = checkJobLiveness(report.workspaceRoot ?? cwd, job, live, brokerFailures, dependencies);
      // A dead owner must be reported even when its pending notes cannot be acknowledged.
      if (job.status === "failed" && (job.errorMessage === "owner process exited" || job.errorMessage === "broker unreachable")) live = null;
      running = job.status === "queued" || job.status === "running";
      if (job.status === "running") {
        const progress = progressAt(job);
        const previous = stalls.get(job.id);
        const lastReported = previous?.progress === progress ? previous.reportedAt : progress;
        if (now() - lastReported >= stallMs) {
          writeLine(`STALLED job=${job.id} thread=${job.threadId ?? "unknown"} ${Math.max(0, Math.floor((now() - progress) / 60000))}m without progress`);
          stalls.set(job.id, { progress, reportedAt: now() });
        }
      }
      if (running && live?.unavailable) continue;
      for (const question of live?.questions ?? []) {
        const key = `${job.id}:${question.requestId}`;
        if (questions.has(key)) continue;
        writeLine(`QUESTION job=${job.id} request=${question.requestId} ${oneLine(question.questions?.[0]?.question).slice(0, 200)}`);
        questions.add(key);
      }
      const pending = (live?.notifications ?? []).filter((note) => !notifications.has(`${job.id}:${note.id}`));
      if (pending.length) {
        try {
          await acknowledge(cwd, job, pending.map((note) => note.id));
        } catch {
          continue;
        }
        for (const note of pending) {
          writeLine(`NOTIFIED job=${job.id} thread=${job.threadId ?? "unknown"} ${oneLine(note.message)}`);
          notifications.add(`${job.id}:${note.id}`);
        }
      }
      if (!running) {
        const prefix = `job=${job.id} thread=${job.threadId ?? "unknown"}`;
        if (job.status === "completed") {
          writeLine(`DONE ${prefix}`);
        } else {
          const error = job.errorMessage ?? readJob(report.workspaceRoot, job.id)?.result?.error?.message;
          writeLine(`FAILED ${prefix} ${String(error ?? "").split(/[\r\n]/)[0] || "unknown"}`);
        }
        active.delete(job.id);
      }
    }
    try {
      await setTimeout(pollMs, undefined, { signal });
    } catch (error) {
      if (error.name !== "AbortError") throw error;
    }
  }
}
