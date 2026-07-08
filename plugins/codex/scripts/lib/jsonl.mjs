/**
 * Helpers for reading the Codex app-server JSONL protocol.
 *
 * The codex CLI's app-server occasionally emits non-JSON bytes onto stdout
 * that have nothing to do with the protocol. Two known sources:
 *
 *   1. Terminal/shell init noise — e.g. zsh writes the bracketed-paste
 *      marker `\x1b[?2004h` when a subprocess inherits the parent's TTY
 *      (issue #23).
 *
 *   2. Localized OS messages on Windows non-English locales. On zh-TW
 *      (CP-950 / Big5), when codex.exe runs `taskkill /T /F` to clean up
 *      a failed MCP child and inadvertently routes taskkill's stdout to
 *      its own stdout, we see the bytes `A6 A8 A5 5C 3A 20 50 49 44 ...`
 *      ("成功: PID 為 xxxx ...") which decode under UTF-8 as
 *      `���\\: PID ...`.
 *
 * Both cases historically tore the broker connection down with
 * `Failed to parse codex app-server JSONL: Unexpected token …`. The
 * client never recovers because `handleExit` rejects every in-flight
 * request before any subsequent valid record arrives.
 *
 * `cleanProtocolLine` is the conservative guard:
 *
 *   - Strip CSI / OSC ANSI escape sequences from the raw line.
 *   - Trim whitespace.
 *   - Require the first remaining character to be `{` or `[`. JSONL
 *     records cannot start with anything else, so any other prefix is
 *     definitively garbage and is dropped.
 *
 * Lines that pass these checks are still parsed with `JSON.parse`; if
 * that fails the caller surfaces a real protocol error as before.
 */

// CSI: ESC [ <params> <intermediates> <final>
//      params       = 0x30..0x3F (digits, ?, etc.)
//      intermediates= 0x20..0x2F (space, !, ", $, %, &, ', (, ), *, +, ,, -, ., /)
//      final        = 0x40..0x7E (any byte in @, A..Z, [, \, ], ^, _, `, a..z, {, |, }, ~)
// This grammar matches the original ECMA-48 spec and covers cases like
// bracketed-paste *content* markers `\x1b[200~` / `\x1b[201~` (final
// byte `~`) which a letter-only `[a-zA-Z]` final misses.
// OSC: ESC ] <text> (BEL | ESC \)            e.g. window-title sets
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

/**
 * Returns a JSON-shaped candidate string for the given raw line, or
 * `null` if the line should be skipped because it cannot be valid JSONL.
 *
 * Accepts arbitrary input — non-string values short-circuit to `null` so
 * callers don't have to type-check before invoking.
 *
 * @param {unknown} rawLine
 * @returns {string | null}
 */
export function cleanProtocolLine(rawLine) {
  if (typeof rawLine !== "string") {
    return null;
  }
  const cleaned = rawLine.replace(ANSI_ESCAPE_RE, "").trim();
  if (!cleaned) {
    return null;
  }
  const firstChar = cleaned.charCodeAt(0);
  if (firstChar !== 0x7B /* { */ && firstChar !== 0x5B /* [ */) {
    return null;
  }
  return cleaned;
}
