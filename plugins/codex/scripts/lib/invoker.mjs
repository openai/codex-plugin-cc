export const INVOKER_VALUES = Object.freeze(["user-slash", "claude-subagent", "claude-bash", "hook"]);
export const DEFAULT_INVOKER = "user-slash";

export function assertInvoker(value) {
  if (INVOKER_VALUES.includes(value)) {
    return value;
  }
  throw new Error(
    `Invalid --invoker value: ${value}. Expected one of: ${INVOKER_VALUES.join(", ")}.`
  );
}
