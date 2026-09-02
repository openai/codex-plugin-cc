import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function createTempDir(prefix = "codex-plugin-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function safeReadFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

const stdinRetryWaitArray = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const STDIN_CHUNK_SIZE = 64 * 1024;

function waitForStdinRetry(delayMs) {
  Atomics.wait(stdinRetryWaitArray, 0, 0, delayMs);
}

function isTransientReadError(error) {
  return error?.code === "EAGAIN" || error?.code === "EWOULDBLOCK";
}

export function readStdinIfPiped({
  stdin = process.stdin,
  readSync = fs.readSync,
  waitForRetry = waitForStdinRetry,
  initialRetryDelayMs = 10,
  maxRetryDelayMs = 500,
  chunkSize = STDIN_CHUNK_SIZE
} = {}) {
  if (stdin.isTTY) {
    return "";
  }

  try {
    Reflect.get(stdin, "_handle")?.setBlocking?.(true);
  } catch {
    // Some stdin handle types do not support changing blocking mode.
  }

  const chunks = [];
  let retryDelayMs = initialRetryDelayMs;
  while (true) {
    const chunk = Buffer.allocUnsafe(chunkSize);
    try {
      const bytesRead = readSync(0, chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(chunk.subarray(0, bytesRead));
      retryDelayMs = initialRetryDelayMs;
    } catch (error) {
      if (!isTransientReadError(error)) {
        throw error;
      }
      waitForRetry(retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, maxRetryDelayMs);
    }
  }
}
