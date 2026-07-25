import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "../fs.mjs";

export const MAX_UNTRACKED_BYTES = 24 * 1024;
export const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
export const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

export function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

export function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

export function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

export function formatSection(title, body) {
  return [`## ${title}`, "", String(body ?? "").trim() || "(none)", ""].join("\n");
}

export function formatBoundedTextFile(displayPath, absolutePath, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_UNTRACKED_BYTES;
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return `### ${displayPath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isDirectory()) {
    return `### ${displayPath}\n(skipped: directory)`;
  }
  if (stat.size > maxBytes) {
    return `### ${displayPath}\n(skipped: ${stat.size} bytes exceeds ${maxBytes} byte limit)`;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return `### ${displayPath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (!isProbablyText(buffer)) {
    return `### ${displayPath}\n(skipped: binary file)`;
  }

  return [`### ${displayPath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

export function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function recommendReviewMode({ fileCount, diffBytes, maxInlineFiles, maxInlineDiffBytes }) {
  if (fileCount === 0 && diffBytes === 0) {
    return "wait";
  }
  return fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes ? "wait" : "background";
}
