import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const CAPTURE_VERSION = 1;
const CAPTURES_DIR_NAME = "verified-review-inputs";
const CAPTURE_TTL_MS = 10 * 60 * 1000;
export const VERIFIED_REVIEW_CAPTURE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const VERIFIED_REVIEW_INPUT_MARKER = "CODEX_VERIFIED_REVIEW_CAPTURE_ID";

function canonicalWorkspaceRoot(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  try {
    return fs.realpathSync.native(workspaceRoot);
  } catch {
    return workspaceRoot;
  }
}

function capturesDir(cwd) {
  return path.join(path.dirname(resolveStateDir(cwd)), CAPTURES_DIR_NAME);
}

function captureFile(cwd, captureId) {
  return path.join(capturesDir(cwd), `${captureId}.json`);
}

function ensureCapturesDir(cwd) {
  const directory = capturesDir(cwd);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}

function isCaptureName(name) {
  const id = path.basename(name, ".json");
  return name.endsWith(".json") && VERIFIED_REVIEW_CAPTURE_ID_PATTERN.test(id);
}

function isClaimedCaptureName(name) {
  const match = /^\.([0-9a-f-]{36})\..+\.claimed$/i.exec(name);
  return Boolean(match && VERIFIED_REVIEW_CAPTURE_ID_PATTERN.test(match[1]));
}

function isExpiredRecord(record, now = Date.now()) {
  return Number.isFinite(record?.createdAt) && record.createdAt + CAPTURE_TTL_MS <= now;
}

function isMalformedRecord(record) {
  return !record || typeof record !== "object" || !Number.isFinite(record.createdAt);
}

function removeFile(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function removeMalformedFileIfExpired(filePath, now) {
  try {
    return fs.statSync(filePath).mtimeMs + CAPTURE_TTL_MS <= now && removeFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function pruneExpiredCaptureRecords(cwd) {
  let names;
  try {
    names = fs.readdirSync(capturesDir(cwd));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  const now = Date.now();
  let removed = 0;
  for (const name of names) {
    if (!isCaptureName(name) && !isClaimedCaptureName(name)) {
      continue;
    }

    const filePath = path.join(capturesDir(cwd), name);
    try {
      const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (isExpiredRecord(record, now) && removeFile(filePath)) {
        removed += 1;
      } else if (isMalformedRecord(record) && removeMalformedFileIfExpired(filePath, now)) {
        removed += 1;
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      if (removeMalformedFileIfExpired(filePath, now)) {
        removed += 1;
      }
    }
  }
  return removed;
}

function isRecordForContext(record, { cwd, sessionId, captureId }) {
  return (
    record &&
    record.version === CAPTURE_VERSION &&
    record.id === captureId &&
    record.sessionId === sessionId &&
    record.workspaceRoot === canonicalWorkspaceRoot(cwd) &&
    Number.isFinite(record.createdAt) &&
    typeof record.rawArguments === "string"
  );
}

export function isVerifiedReviewCommand(value) {
  return /^(?:codex:)?verified-review$/.test(String(value ?? ""));
}

export function captureVerifiedReviewInput({ cwd, sessionId, rawArguments }) {
  if (!sessionId) {
    throw new Error("A Claude session ID is required to capture verified-review arguments.");
  }
  if (typeof rawArguments !== "string") {
    throw new Error("Verified-review command arguments must be a string.");
  }

  pruneExpiredCaptureRecords(cwd);

  const id = randomUUID();
  const filePath = captureFile(cwd, id);
  const record = {
    version: CAPTURE_VERSION,
    id,
    sessionId: String(sessionId),
    workspaceRoot: canonicalWorkspaceRoot(cwd),
    createdAt: Date.now(),
    rawArguments
  };

  ensureCapturesDir(cwd);
  const file = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  } finally {
    fs.closeSync(file);
  }

  return { id };
}

export function consumeVerifiedReviewInput(cwd, captureId, { sessionId } = {}) {
  if (!sessionId || !VERIFIED_REVIEW_CAPTURE_ID_PATTERN.test(String(captureId ?? ""))) {
    return null;
  }

  pruneExpiredCaptureRecords(cwd);

  const normalizedId = String(captureId);
  const source = captureFile(cwd, normalizedId);
  const claimed = path.join(capturesDir(cwd), `.${normalizedId}.${process.pid}.${randomUUID()}.claimed`);

  try {
    fs.renameSync(source, claimed);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  try {
    const record = JSON.parse(fs.readFileSync(claimed, "utf8"));
    if (
      isExpiredRecord(record) ||
      !isRecordForContext(record, { cwd, sessionId: String(sessionId), captureId: normalizedId })
    ) {
      return null;
    }
    return { rawArguments: record.rawArguments };
  } catch {
    return null;
  } finally {
    removeFile(claimed);
  }
}

export function cleanupVerifiedReviewInputs({ cwd, sessionId }) {
  if (!sessionId) {
    return 0;
  }

  pruneExpiredCaptureRecords(cwd);

  let names;
  try {
    names = fs.readdirSync(capturesDir(cwd));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  const normalizedSessionId = String(sessionId);
  let removed = 0;
  for (const name of names) {
    if (!isCaptureName(name)) {
      continue;
    }

    const filePath = path.join(capturesDir(cwd), name);
    try {
      const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (record.sessionId !== normalizedSessionId) {
        continue;
      }
      if (removeFile(filePath)) {
        removed += 1;
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      if (removeMalformedFileIfExpired(filePath, Date.now())) {
        removed += 1;
      }
    }
  }

  return removed;
}
