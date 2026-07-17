/**
 * Rig-edition additive layer: model-tier routing, envelope validation, and
 * quota failover for Codex dispatches.
 *
 * This module is deliberately additive -- it composes the existing
 * lib/codex.mjs entry points rather than changing their signatures, so
 * upstream rebases of codex.mjs stay cheap. New callers opt in by importing
 * from here.
 *
 * @typedef {"sol" | "terra" | "luna"} ModelTier
 * @typedef {"low" | "medium" | "high" | "xhigh" | "max" | "ultra"} ReasoningEffort
 * @typedef {"DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED"} EnvelopeStatus
 * @typedef {{
 *   status: EnvelopeStatus,
 *   summary: string,
 *   files_modified: string[],
 *   concerns: string[],
 *   blocked_reason: string | null
 * }} Envelope
 */

import { runAppServerTurn } from "./codex.mjs";
import { runExecTurn } from "./exec-transport.mjs";

/** Canonical tier -> full model id, per verified-facts-2026-07-11.md. */
export const MODEL_ALIASES = Object.freeze({
  sol: "gpt-5.6-sol",
  terra: "gpt-5.6-terra",
  luna: "gpt-5.6-luna"
});

const TIER_ORDER = Object.freeze(["sol", "terra", "luna"]);
const TIER_STEP_DOWN = Object.freeze({ sol: "terra", terra: "luna", luna: null });
const MODEL_ID_TO_TIER = new Map(TIER_ORDER.map((tier) => [MODEL_ALIASES[tier], tier]));

const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const SOL_ONLY_EFFORTS = new Set(["max", "ultra"]);

const QUOTA_EXHAUSTED_REASON = "QUOTA_EXHAUSTED";
const QUOTA_ERROR_PATTERNS = [
  /\b429\b/,
  /rate[\s_-]?limit/i,
  /insufficient[\s_-]?quota/i,
  /quota[\s_-]?exceeded/i,
  /too many requests/i
];

function normalizeKey(value) {
  if (value == null) {
    return "";
  }
  return String(value).trim().toLowerCase();
}

/**
 * Resolves a tier alias ("sol"/"terra"/"luna") or a full model id
 * ("gpt-5.6-sol") to its canonical { tier, modelId } pair.
 * @param {string | null | undefined} aliasOrModelId
 * @returns {{ tier: ModelTier, modelId: string } | null}
 */
export function resolveTier(aliasOrModelId) {
  const normalized = normalizeKey(aliasOrModelId);
  if (!normalized) {
    return null;
  }
  if (TIER_ORDER.includes(normalized)) {
    return { tier: normalized, modelId: MODEL_ALIASES[normalized] };
  }
  const tierFromModelId = MODEL_ID_TO_TIER.get(normalized);
  return tierFromModelId ? { tier: tierFromModelId, modelId: MODEL_ALIASES[tierFromModelId] } : null;
}

/**
 * Reports whether a reasoning effort value is usable on the given tier.
 * max/ultra are sol-only per the verified 0.144.0 catalog.
 * @param {ModelTier} tier
 * @param {string} effort
 */
export function isEffortValidForTier(tier, effort) {
  if (!VALID_EFFORTS.has(effort)) {
    return false;
  }
  return !(SOL_ONLY_EFFORTS.has(effort) && tier !== "sol");
}

/**
 * Returns the next tier down the failover chain (sol -> terra -> luna -> null).
 * @param {ModelTier} tier
 * @returns {ModelTier | null}
 */
export function nextTierDown(tier) {
  return TIER_STEP_DOWN[tier] ?? null;
}

/** Per-verb tier + effort defaults, overridable per call via tierDefaultsForVerb. */
export const PER_VERB_TIER_DEFAULTS = Object.freeze({
  delegate: Object.freeze({ tier: "terra", effort: "medium" }),
  implement: Object.freeze({ tier: "terra", effort: "medium" }),
  review: Object.freeze({ tier: "sol", effort: "high" }),
  adversarial: Object.freeze({ tier: "sol", effort: "high" }),
  bulk: Object.freeze({ tier: "luna", effort: "low" }),
  mechanical: Object.freeze({ tier: "luna", effort: "low" })
});

/**
 * Looks up the tier + effort default for a verb, applying any per-call
 * overrides. Throws on an unknown verb, an unresolvable tier override, or
 * an effort that is not valid for the resolved tier.
 * @param {string} verb
 * @param {{ tier?: string, effort?: string }} [overrides]
 * @returns {{ tier: ModelTier, modelId: string, effort: string }}
 */
export function tierDefaultsForVerb(verb, overrides = {}) {
  const base = PER_VERB_TIER_DEFAULTS[normalizeKey(verb)];
  if (!base) {
    throw new Error(`Unknown verb "${verb}". Use one of: ${Object.keys(PER_VERB_TIER_DEFAULTS).join(", ")}.`);
  }

  const resolved = resolveTier(overrides.tier ?? base.tier);
  if (!resolved) {
    throw new Error(`Unknown model tier "${overrides.tier}". Use one of: ${TIER_ORDER.join(", ")}.`);
  }

  const requestedEffort = overrides.effort ? normalizeKey(overrides.effort) : base.effort;
  if (!isEffortValidForTier(resolved.tier, requestedEffort)) {
    const detail = SOL_ONLY_EFFORTS.has(requestedEffort)
      ? `Effort "${requestedEffort}" is sol-only; tier "${resolved.tier}" cannot use it.`
      : `Unsupported effort "${requestedEffort}". Use one of: ${[...VALID_EFFORTS].join(", ")}.`;
    throw new Error(detail);
  }

  return { tier: resolved.tier, modelId: resolved.modelId, effort: requestedEffort };
}

const ENVELOPE_STATUSES = new Set(["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"]);
const ENVELOPE_KEYS = Object.freeze(["status", "summary", "files_modified", "concerns", "blocked_reason"]);
const ENVELOPE_KEY_SET = new Set(ENVELOPE_KEYS);

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isValidEnvelopeShape(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }

  const keys = Object.keys(candidate);
  if (keys.length !== ENVELOPE_KEYS.length || !keys.every((key) => ENVELOPE_KEY_SET.has(key))) {
    return false;
  }

  if (!ENVELOPE_STATUSES.has(candidate.status)) {
    return false;
  }
  if (typeof candidate.summary !== "string") {
    return false;
  }
  if (!isStringArray(candidate.files_modified)) {
    return false;
  }
  if (!isStringArray(candidate.concerns)) {
    return false;
  }
  return candidate.blocked_reason === null || typeof candidate.blocked_reason === "string";
}

/**
 * Finds every balanced top-level `{...}` substring starting at each `{`
 * in source order, respecting quoted strings and escapes. Never throws --
 * unterminated braces are simply skipped.
 * @param {string} source
 * @returns {string[]}
 */
function extractJsonObjectCandidates(source) {
  const candidates = [];

  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== "{") {
      continue;
    }

    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let end = start; end < source.length; end += 1) {
      const char = source[end];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (inString) {
        if (char === "\\") {
          escapeNext = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(source.slice(start, end + 1));
          break;
        }
      }
    }
  }

  return candidates;
}

/**
 * Parses the first valid envelope-shaped JSON object found in text,
 * tolerating surrounding prose. Defensive by design: malformed or
 * non-conforming input yields null rather than throwing.
 * @param {string | null | undefined} text
 * @returns {Readonly<Envelope> | null}
 */
export function parseEnvelope(text) {
  if (text == null) {
    return null;
  }

  for (const candidate of extractJsonObjectCandidates(String(text))) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (isValidEnvelopeShape(parsed)) {
      return Object.freeze({ ...parsed });
    }
  }

  return null;
}

/**
 * Builds a BLOCKED envelope for a given reason (e.g. "QUOTA_EXHAUSTED").
 * @param {string} reason
 * @param {{ summary?: string, filesModified?: string[], concerns?: string[] }} [extra]
 * @returns {Readonly<Envelope>}
 */
export function makeBlockedEnvelope(reason, extra = {}) {
  return Object.freeze({
    status: "BLOCKED",
    summary: extra.summary ?? `Blocked: ${reason}`,
    files_modified: Object.freeze([...(extra.filesModified ?? [])]),
    concerns: Object.freeze([...(extra.concerns ?? [])]),
    blocked_reason: reason
  });
}

/**
 * Classifies an error or response as a quota/rate-limit failure (429,
 * "rate limit", "insufficient quota", etc.), checking status-like fields
 * first and falling back to a message pattern match.
 * @param {unknown} errorOrResponse
 */
export function classifyQuotaError(errorOrResponse) {
  if (!errorOrResponse) {
    return false;
  }

  const statusCode =
    errorOrResponse.status ?? errorOrResponse.statusCode ?? errorOrResponse.code ?? errorOrResponse.rpcCode ?? null;
  if (statusCode === 429 || statusCode === "429") {
    return true;
  }

  const message = String(errorOrResponse.message ?? errorOrResponse.error?.message ?? errorOrResponse.detail ?? "");
  return QUOTA_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Runs fn at the requested tier. On a classified quota error, retries
 * exactly once at the next tier down. If that retry also fails on quota,
 * returns a BLOCKED envelope with blocked_reason "QUOTA_EXHAUSTED" instead
 * of throwing. Non-quota errors are rethrown unchanged.
 * @param {(context: { tier: ModelTier, modelId: string }) => Promise<unknown>} fn
 * @param {{ tier: string }} options
 */
export async function withQuotaFailover(fn, options = {}) {
  const startTier = resolveTier(options.tier);
  if (!startTier) {
    throw new Error(`Unknown model tier "${options.tier}". Use one of: ${TIER_ORDER.join(", ")}.`);
  }

  try {
    return await fn({ tier: startTier.tier, modelId: startTier.modelId });
  } catch (error) {
    if (!classifyQuotaError(error)) {
      throw error;
    }

    const fallbackTierName = nextTierDown(startTier.tier);
    if (!fallbackTierName) {
      return makeBlockedEnvelope(QUOTA_EXHAUSTED_REASON, {
        summary: `Quota exhausted at tier "${startTier.tier}" with no lower tier available.`
      });
    }

    const fallbackTier = resolveTier(fallbackTierName);
    try {
      return await fn({ tier: fallbackTier.tier, modelId: fallbackTier.modelId });
    } catch (fallbackError) {
      if (!classifyQuotaError(fallbackError)) {
        throw fallbackError;
      }
      return makeBlockedEnvelope(QUOTA_EXHAUSTED_REASON, {
        summary: `Quota exhausted at tier "${startTier.tier}" and step-down tier "${fallbackTier.tier}".`
      });
    }
  }
}

// withQuotaFailover only retries when the wrapped fn REJECTS with a
// classified quota error. runExecTurn never rejects for a failed turn (by
// design -- see exec-transport.mjs's "never throw" contract for turn
// failures, only for preconditions); a real 429 there surfaces as a
// resolved { status: 1, error, stderr } instead, which withQuotaFailover
// has nothing to catch and so silently strands the caller at the starting
// tier (core-review BLOCKING 2). This reclassifies such a result into a
// thrown, quota-classified error so withQuotaFailover handles it exactly
// like the app-server path, which already throws for a genuine quota
// rejection via its own JSON-RPC error propagation -- hence this check is
// scoped to non-app-server transports only.
function isQuotaClassifiedExecFailure(result) {
  if (!result || result.status === 0) {
    return false;
  }
  const combinedMessage = [result.error?.message, result.stderr].filter(Boolean).join("\n");
  return combinedMessage ? classifyQuotaError({ message: combinedMessage }) : false;
}

/**
 * Composes a Codex transport (exec by default, or the app-server) with tier
 * resolution and quota failover, then attaches a parsed envelope (or null)
 * to the result. Callers pass either a verb (to use PER_VERB_TIER_DEFAULTS)
 * or an explicit tier alias; a verb plus tier/effort overrides both work via
 * tierDefaultsForVerb.
 *
 * This is a new entry point, not a replacement for runAppServerTurn/
 * runExecTurn -- existing direct callers of either transport are unaffected.
 * @param {string} cwd
 * @param {Record<string, unknown> & { verb?: string, tier?: string, effort?: string, transport?: "exec" | "app-server" }} [options]
 */
export async function runTieredTurn(cwd, options = {}) {
  const { verb, tier, effort, transport, ...turnOptions } = options;

  const resolvedDefaults = verb
    ? tierDefaultsForVerb(verb, { tier, effort })
    : (() => {
        const resolved = resolveTier(tier);
        if (!resolved) {
          throw new Error("runTieredTurn requires either options.verb or a resolvable options.tier.");
        }
        if (effort && !isEffortValidForTier(resolved.tier, normalizeKey(effort))) {
          throw new Error(`Unsupported effort "${effort}" for tier "${resolved.tier}".`);
        }
        return { tier: resolved.tier, modelId: resolved.modelId, effort: effort ? normalizeKey(effort) : null };
      })();

  const runTurn = transport === "app-server" ? runAppServerTurn : runExecTurn;

  const outcome = await withQuotaFailover(
    async ({ modelId }) => {
      const result = await runTurn(cwd, {
        ...turnOptions,
        model: modelId,
        effort: resolvedDefaults.effort
      });

      if (transport !== "app-server" && isQuotaClassifiedExecFailure(result)) {
        const quotaError = new Error(result.error?.message || result.stderr || "codex exec reported a quota/rate-limit failure.");
        quotaError.status = 429;
        throw quotaError;
      }

      return result;
    },
    { tier: resolvedDefaults.tier }
  );

  if (outcome?.status === "BLOCKED" && outcome?.blocked_reason === QUOTA_EXHAUSTED_REASON) {
    return outcome;
  }

  return { ...outcome, envelope: parseEnvelope(outcome?.finalMessage) };
}

/**
 * Back-compat alias for callers written against the pre-exec-transport API.
 * Always routes to the app-server transport regardless of the caller's
 * environment default.
 * @param {string} cwd
 * @param {Record<string, unknown> & { verb?: string, tier?: string, effort?: string }} [options]
 */
export const runTieredAppServerTurn = (cwd, options = {}) => runTieredTurn(cwd, { ...options, transport: "app-server" });

export { QUOTA_EXHAUSTED_REASON };
