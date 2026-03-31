import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getCodexLoginStatus } from "../plugins/codex/scripts/lib/codex.mjs";

/**
 * Creates a temporary HOME with a fake ~/.codex/auth.json so
 * getCodexLoginStatus can read the token file directly without
 * spawning the codex binary (which panics on macOS in sandboxed
 * environments due to SCDynamicStore access being blocked).
 */
function withTempAuthHome(authPayload, fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-test-"));
  const codexDir = path.join(tmpHome, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "auth.json"),
    JSON.stringify(authPayload),
    "utf8"
  );

  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = tmpHome;
    delete process.env.USERPROFILE;
    return fn(tmpHome);
  } finally {
    process.env.HOME = origHome;
    if (origUserProfile !== undefined) {
      process.env.USERPROFILE = origUserProfile;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

test("getCodexLoginStatus detects ChatGPT auth from auth.json tokens", () => {
  const result = withTempAuthHome(
    {
      auth_mode: "chatgpt",
      tokens: {
        access_token: "fake-access-token",
        refresh_token: "fake-refresh-token",
        id_token: "fake-id-token"
      },
      last_refresh: "2026-01-01T00:00:00Z"
    },
    () => getCodexLoginStatus(process.cwd())
  );

  // The file-based check should return loggedIn: true without
  // ever calling `codex login status`.
  assert.equal(result.loggedIn, true);
  assert.equal(result.detail, "Logged in using ChatGPT");
});

test("getCodexLoginStatus detects API key auth from auth.json", () => {
  const result = withTempAuthHome(
    {
      OPENAI_API_KEY: "sk-fake-key-for-test"
    },
    () => getCodexLoginStatus(process.cwd())
  );

  assert.equal(result.loggedIn, true);
  assert.equal(result.detail, "Logged in using API key");
});

test("getCodexLoginStatus falls through when auth.json has no tokens", () => {
  const result = withTempAuthHome(
    { auth_mode: "chatgpt", tokens: {} },
    () => getCodexLoginStatus(process.cwd())
  );

  // Without valid tokens, the function should fall through to the
  // binary check.  Since codex may or may not be installed in the
  // test environment, we just verify it did NOT return loggedIn: true
  // from the file-based path.
  assert.equal(result.loggedIn, false);
});
