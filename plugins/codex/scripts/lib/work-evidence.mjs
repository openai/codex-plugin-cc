/**
 * Work-evidence assessment for Codex task runs (fleet#264).
 *
 * The codex bridge previously treated `exitStatus === 0` (turn status "completed") as
 * "the delegate did the work". A turn's exit status reports app-server/process health, never
 * work completion: a turn in which the model described a plan and ended with no tool call
 * exits/completes exactly like a turn that made the change. Tonight's live specimen (fleet#292,
 * closed) is this shape end to end -- the REPORT claimed work and run_state said delivered, but
 * the actual PR diff was empty.
 *
 * Unlike the Grok CLI bridge (fleet#254 / xai-org/grok-build-plugin-cc#16), the Codex app-server
 * protocol already returns structured per-turn telemetry for every run -- `fileChanges` and
 * `commandExecutions` thread items collected in `captureTurn` (scripts/lib/codex.mjs) -- so there
 * is no JSON-envelope-parsing step to port. The signal is always available; this module only has
 * to decide, from that already-collected telemetry, whether the turn shows real work.
 */

/**
 * Decide whether a finished Codex task turn carries positive evidence that work happened.
 *
 * Two outcomes, deliberately distinct from "the process/turn exited cleanly":
 *  - `noWork: true`  proof of no work for a `--write` run (no files touched, no commands run),
 *                     or a run of any kind that returned no output text at all. Terminal status
 *                     must be `failed`.
 *  - neither          positive evidence of at least one tool round-trip (or, for a read-only
 *                     run, at least some output text).
 *
 * A read-only (`write: false`) run is not expected to touch files or run shell commands -- it
 * may legitimately just answer a question -- so the touched-file/command-count gate only applies
 * when `write` is true. The empty-output check applies either way: a turn with zero output text
 * and zero tool activity is not evidence of anything.
 *
 * @param {object} args
 * @param {boolean} [args.write] whether this task run was invoked with `--write`
 * @param {Array} [args.touchedFiles] touched-file list from the turn (codex.mjs `collectTouchedFiles`)
 * @param {Array} [args.commandExecutions] command-execution thread items from the turn
 * @param {string} [args.text] the turn's rendered/final output text
 * @param {boolean} [args.requireWork] enforce the gate at all (default true)
 */
export function assessWorkEvidence({
  write = false,
  touchedFiles = [],
  commandExecutions = [],
  text = "",
  requireWork = true
} = {}) {
  const evidence = {
    write: Boolean(write),
    touchedFileCount: Array.isArray(touchedFiles) ? touchedFiles.length : 0,
    commandCount: Array.isArray(commandExecutions) ? commandExecutions.length : 0,
    outputChars: typeof text === "string" ? text.trim().length : 0
  };

  if (!requireWork) {
    return { noWork: false, reasons: [], evidence, enforced: false };
  }

  const reasons = [];

  if (evidence.write && evidence.touchedFileCount === 0 && evidence.commandCount === 0) {
    reasons.push(
      "This task was run with --write but the turn touched no files and executed no commands: it described the change instead of making it (fleet#292 shape)."
    );
  }

  if (evidence.outputChars === 0 && evidence.commandCount === 0 && evidence.touchedFileCount === 0) {
    reasons.push("The delegate returned no output text and made no tool calls.");
  }

  return { noWork: reasons.length > 0, reasons, evidence, enforced: true };
}

/**
 * Human-readable banner appended to the rendered result so a caller reading only the
 * rendered text cannot miss an empty run.
 */
export function renderWorkEvidenceBanner(verdict) {
  if (!verdict || !verdict.enforced || !verdict.noWork) {
    return "";
  }
  return [
    "",
    "!! EMPTY RUN -- NO WORK PERFORMED (fleet#264 guard) !!",
    ...verdict.reasons.map((reason) => `- ${reason}`),
    "This run is marked FAILED. Do not treat its output, or any REPORT/run_state built from it, as evidence of delivered work.",
    ""
  ].join("\n");
}
