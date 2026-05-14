/**
 * Soft budget for non-user Codex review invocations.
 *
 * `parseReviewRateLimit` returns a three-state result: `{ kind: "absent" }`
 * for an unset or blank env value, `{ kind: "invalid", raw }` for a non-empty
 * malformed value, and `{ kind: "active", count, windowMs }` for a valid
 * `<positive int>/<positive int>min` value. Windows are capped at 60 minutes
 * because state pruning retains 65 minutes of review records, leaving a 5
 * minute safety margin around the enforceable window. Counts are capped at
 * 500 because pruning retains at most 500 recent review records, so higher
 * budgets could not be enforced from persisted state.
 *
 * Per ADR 0002, `invoker` is self-declared. A caller that passes
 * `--invoker user-slash` intentionally bypasses this limiter; this module is
 * not a security boundary and does not attempt to authenticate that claim.
 *
 * The check is also non-atomic: concurrent non-user review starts can observe
 * the same pre-persisted state and both pass an N/Xmin limit. This accepted
 * limitation keeps the opt-in, disabled-by-default budget simple and avoids a
 * state-directory lock for typical sequential automation.
 *
 * State pruning preserves review records less than 65 minutes old so this
 * limiter can count the configured one-hour window. Older review records may
 * still be evicted under MAX_JOBS pressure.
 */
import { DEFAULT_INVOKER } from "./invoker.mjs";
import { MAX_RECENT_REVIEW_JOBS } from "./state.mjs";

const RATE_LIMIT_ENV = "CODEX_PLUGIN_REVIEW_RATE_LIMIT";
const RATE_LIMIT_EXPECTATION = `(expected <positive int>/<positive int>min, with count <= ${MAX_RECENT_REVIEW_JOBS} and minutes <= 60)`;
const warnedInvalidRateLimits = new Set();

function isReviewJob(job) {
  return job?.jobClass === "review" || job?.kind === "review" || job?.kind === "adversarial-review";
}

function getJobCreatedMs(job) {
  const timestamp = Date.parse(job?.createdAt ?? job?.startedAt ?? job?.updatedAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function parseReviewRateLimit(envValue) {
  const raw = envValue == null ? "" : String(envValue).trim();
  if (raw === "") {
    return { kind: "absent" };
  }

  const match = /^(\d+)\/(\d+)min$/.exec(raw);
  if (!match) {
    return { kind: "invalid", raw };
  }

  const count = Number(match[1]);
  const minutes = Number(match[2]);
  if (
    !Number.isSafeInteger(count) ||
    !Number.isSafeInteger(minutes) ||
    count <= 0 ||
    minutes <= 0 ||
    count > MAX_RECENT_REVIEW_JOBS ||
    minutes > 60
  ) {
    return { kind: "invalid", raw };
  }

  return {
    kind: "active",
    count,
    windowMs: minutes * 60_000
  };
}

export function enforceReviewRateLimit({
  workspaceRoot,
  invoker,
  env,
  now,
  listJobs,
  warn = (message) => process.stderr.write(`${message}\n`)
}) {
  if (invoker === DEFAULT_INVOKER) {
    return;
  }

  const rateLimit = parseReviewRateLimit(env?.[RATE_LIMIT_ENV]);
  if (rateLimit.kind === "absent") {
    return;
  }

  if (rateLimit.kind === "invalid") {
    const warningMessage = `${RATE_LIMIT_ENV}="${rateLimit.raw}" is not a valid rate limit ${RATE_LIMIT_EXPECTATION}. Non-user-slash reviews are refused until this is fixed.`;
    if (!warnedInvalidRateLimits.has(rateLimit.raw)) {
      warnedInvalidRateLimits.add(rateLimit.raw);
      warn(warningMessage);
    }
    throw new Error(
      `Codex review rate limit misconfigured: ${RATE_LIMIT_ENV}="${rateLimit.raw}" is not a valid rate limit ${RATE_LIMIT_EXPECTATION}. Refusing invoker ${invoker} until this is fixed. Run \`/codex:adversarial-review\` (user-slash) to bypass.`
    );
  }

  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const effectiveNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const cutoff = effectiveNow - rateLimit.windowMs;
  const used = listJobs(workspaceRoot).filter((job) => {
    if (!isReviewJob(job) || job.invoker === undefined || typeof job.invoker !== "string") {
      return false;
    }
    if (job.invoker === DEFAULT_INVOKER) {
      return false;
    }
    const createdMs = getJobCreatedMs(job);
    return createdMs != null && createdMs >= cutoff && createdMs <= effectiveNow;
  }).length;

  if (used >= rateLimit.count) {
    const minutes = rateLimit.windowMs / 60_000;
    throw new Error(
      `Codex review rate limit exceeded: ${rateLimit.count}/${minutes}min for invoker ${invoker}. Run \`/codex:adversarial-review\` (user-slash) to bypass.`
    );
  }
}
