/**
 * Rig-edition cloud verb: a thin, envelope-wrapping passthrough over the
 * `codex cloud` CLI surface (EXPERIMENTAL upstream; verified 0.144.1).
 *
 * `codex cloud` browses and drives OpenAI-hosted Codex Cloud tasks -- a
 * different execution target than the local app-server turns the rest of
 * rig-edition drives. It is not an app-server JSON-RPC session, so there is
 * no structured Codex-side envelope to parse; this module builds one from
 * the CLI's exit status instead.
 *
 * Verified subcommand surface (codex cloud --help / <subcommand> --help,
 * 0.144.1): exec, status, list, apply, diff. `exec` requires --env <ENV_ID>
 * (a Codex Cloud environment id, not a local worktree) and takes an
 * optional --branch/--attempts; `list` supports --env/--limit/--cursor/
 * --json; `status`/`apply`/`diff` take a positional task id, with
 * apply/diff also accepting --attempt.
 */
import { runCommand } from "./process.mjs";

export const CLOUD_SUBCOMMANDS = Object.freeze(["exec", "status", "list", "apply", "diff"]);

function pushValueArg(args, flag, value) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  args.push(flag, String(value));
}

function requireTaskId(options) {
  if (!isNonEmptyString(options.taskId)) {
    throw new Error("This `codex cloud` subcommand requires a task id.");
  }
  return String(options.taskId);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function buildExecArgs(options) {
  if (!isNonEmptyString(options.env)) {
    throw new Error("`codex cloud exec` requires --env <ENV_ID>.");
  }
  const args = ["--env", String(options.env)];
  pushValueArg(args, "--attempts", options.attempts);
  pushValueArg(args, "--branch", options.branch);
  if (isNonEmptyString(options.query)) {
    args.push(String(options.query));
  }
  return args;
}

function buildStatusArgs(options) {
  return [requireTaskId(options)];
}

function buildListArgs(options) {
  const args = [];
  pushValueArg(args, "--env", options.env);
  pushValueArg(args, "--limit", options.limit);
  pushValueArg(args, "--cursor", options.cursor);
  if (options.json) {
    args.push("--json");
  }
  return args;
}

function buildApplyArgs(options) {
  const args = [requireTaskId(options)];
  pushValueArg(args, "--attempt", options.attempt);
  return args;
}

function buildDiffArgs(options) {
  const args = [requireTaskId(options)];
  pushValueArg(args, "--attempt", options.attempt);
  return args;
}

const ARG_BUILDERS = Object.freeze({
  exec: buildExecArgs,
  status: buildStatusArgs,
  list: buildListArgs,
  apply: buildApplyArgs,
  diff: buildDiffArgs
});

/**
 * Builds the full `codex cloud <subcommand> ...` argv for a given verb and
 * options, applying the same validation the upstream CLI would enforce.
 * @param {string} subcommand
 * @param {Record<string, unknown>} [options]
 * @returns {string[]}
 */
export function buildCloudArgs(subcommand, options = {}) {
  const builder = ARG_BUILDERS[subcommand];
  if (!builder) {
    throw new Error(`Unknown "codex cloud" subcommand "${subcommand}". Use one of: ${CLOUD_SUBCOMMANDS.join(", ")}.`);
  }
  return ["cloud", subcommand, ...builder(options)];
}

function buildEnvelope(subcommand, result) {
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  const succeeded = !result.error && result.status === 0;

  return Object.freeze({
    status: succeeded ? "DONE" : "BLOCKED",
    summary: succeeded ? `codex cloud ${subcommand} completed.` : `codex cloud ${subcommand} failed.`,
    files_modified: Object.freeze([]),
    concerns: Object.freeze(succeeded ? [] : [stderr || stdout || `exit ${result.status}`]),
    blocked_reason: succeeded ? null : "CLOUD_COMMAND_FAILED"
  });
}

/**
 * Runs a `codex cloud` subcommand and wraps the result in a typed envelope.
 * @param {string} subcommand
 * @param {Record<string, unknown> & { cwd?: string, runCommand?: typeof runCommand }} [options]
 */
export function runCloudCommand(subcommand, options = {}) {
  const runner = options.runCommand ?? runCommand;
  const args = buildCloudArgs(subcommand, options);
  const result = runner("codex", args, { cwd: options.cwd, shell: false });

  return Object.freeze({
    exitStatus: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    envelope: buildEnvelope(subcommand, result)
  });
}
