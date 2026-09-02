import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function normalizeExpectedSha256(value) {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error("`--prompt-file-sha256` must be exactly 64 hexadecimal characters.");
  }
  return normalized;
}

function digestsEqual(leftHex, rightHex) {
  const left = Buffer.from(leftHex, "hex");
  const right = Buffer.from(rightHex, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function readTaskPromptInput(cwd, options, positionals, readStdin) {
  const expectedSha256 = normalizeExpectedSha256(options["prompt-file-sha256"]);
  const promptFile = options["prompt-file"];
  if (expectedSha256 && !promptFile) {
    throw new Error("`--prompt-file-sha256` requires `--prompt-file <path>`.");
  }

  if (promptFile) {
    const resolvedPath = path.resolve(cwd, promptFile);
    const bytes = fs.readFileSync(resolvedPath);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (expectedSha256 && !digestsEqual(expectedSha256, sha256)) {
      throw new Error(
        `Prompt file SHA-256 mismatch for ${resolvedPath}: expected ${expectedSha256}, received ${sha256}.`
      );
    }
    return {
      text: bytes.toString("utf8"),
      source: "file",
      sha256,
      filePath: resolvedPath
    };
  }

  const positionalPrompt = positionals.join(" ");
  if (positionalPrompt) {
    return { text: positionalPrompt, source: "positional", sha256: null, filePath: null };
  }
  return {
    text: readStdin(),
    source: "stdin",
    sha256: null,
    filePath: null
  };
}
