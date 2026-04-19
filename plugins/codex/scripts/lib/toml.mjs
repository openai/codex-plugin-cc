/**
 * toml.mjs
 *
 * Minimal TOML reader/writer that covers the subset used by Codex config:
 *   - key = "string value"
 *   - key = 123
 *   - key = true / false
 *   - # comments
 *   - [section] headers (read-only; not needed for flat codex config)
 *
 * This is intentionally small. It does NOT support arrays, inline tables,
 * multi-line strings, or dates. Those are not used in .codex/config.toml.
 */

/**
 * Parse a TOML string into a plain object.
 * Only handles the flat key=value format Codex uses.
 *
 * @param {string} text
 * @returns {Record<string, string|number|boolean>}
 */
export function parseToml(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;

    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    const rawValue = line.slice(eqIdx + 1).trim();

    if (!key) continue;

    result[key] = parseTomlValue(rawValue);
  }
  return result;
}

function parseTomlValue(raw) {
  // Quoted string
  if ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // Boolean
  if (raw === "true") return true;
  if (raw === "false") return false;
  // Number
  const num = Number(raw);
  if (!isNaN(num) && raw !== "") return num;
  // Fallback: return as-is
  return raw;
}

/**
 * Stringify a plain flat object to TOML.
 * Preserves comments and ordering of an existing TOML string when provided.
 *
 * @param {Record<string, string|number|boolean>} data
 * @param {string} [existingToml] - original file content to preserve comments/order
 * @returns {string}
 */
export function stringifyToml(data, existingToml = "") {
  const lines = existingToml ? existingToml.split(/\r?\n/) : [];
  const written = new Set();
  const output = [];

  // First pass: update existing lines in-place
  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#") || line.startsWith("[")) {
      output.push(rawLine);
      continue;
    }

    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) {
      output.push(rawLine);
      continue;
    }

    const key = line.slice(0, eqIdx).trim();
    if (key in data) {
      output.push(`${key} = ${tomlValue(data[key])}`);
      written.add(key);
    } else {
      // Key was removed — drop the line
    }
  }

  // Second pass: append new keys not present in the original
  for (const [key, value] of Object.entries(data)) {
    if (!written.has(key)) {
      output.push(`${key} = ${tomlValue(value)}`);
    }
  }

  const result = output.join("\n").trimEnd();
  return result ? result + "\n" : "";
}

function tomlValue(value) {
  if (typeof value === "string") return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return `"${String(value)}"`;
}
