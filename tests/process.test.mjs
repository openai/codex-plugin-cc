import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { formatCodexUnavailableError, getCodexAvailability } from "../plugins/codex/scripts/lib/codex.mjs";
import {
  binaryAvailable,
  isPowerShellPath,
  isShellPolicyRejection,
  resolveCommandShell,
  resolveWindowsShell,
  terminateProcessTree
} from "../plugins/codex/scripts/lib/process.mjs";

const SAMPLE_PS_POLICY_ERROR = [
  "codex : File C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.ps1 cannot be loaded because running ",
  "scripts is disabled on this system. For more information, see about_Execution_Policies at ",
  "https:/go.microsoft.com/fwlink/?LinkID=135170.",
  "    + CategoryInfo          : SecurityError: (:) [], PSSecurityException",
  "    + FullyQualifiedErrorId : UnauthorizedAccess"
].join("\r\n");

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("isPowerShellPath detects Windows PowerShell and PowerShell 7 executables", () => {
  assert.equal(isPowerShellPath("powershell"), true);
  assert.equal(isPowerShellPath("powershell.exe"), true);
  assert.equal(isPowerShellPath("pwsh"), true);
  assert.equal(isPowerShellPath("pwsh.exe"), true);
  assert.equal(isPowerShellPath("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"), true);
  assert.equal(isPowerShellPath("\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\""), true);
  assert.equal(isPowerShellPath("C:\\Program Files\\Git\\bin\\bash.exe"), false);
  assert.equal(isPowerShellPath("C:\\Windows\\System32\\cmd.exe"), false);
  assert.equal(isPowerShellPath(""), false);
  assert.equal(isPowerShellPath(null), false);
});

test("resolveWindowsShell avoids PowerShell SHELL while preserving Git Bash", () => {
  assert.equal(
    resolveWindowsShell({
      SHELL: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      SystemRoot: "C:\\Windows"
    }),
    "C:\\Windows\\system32\\cmd.exe"
  );

  assert.equal(
    resolveWindowsShell({
      SHELL: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      ComSpec: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      SystemRoot: "C:\\Windows"
    }),
    "C:\\Windows\\System32\\cmd.exe"
  );

  assert.equal(
    resolveWindowsShell({
      SHELL: "pwsh.exe"
    }),
    "cmd.exe"
  );

  assert.equal(
    resolveWindowsShell({
      SHELL: "C:\\Program Files\\Git\\bin\\bash.exe",
      ComSpec: "C:\\Windows\\system32\\cmd.exe"
    }),
    "C:\\Program Files\\Git\\bin\\bash.exe"
  );
});

test("resolveCommandShell honors explicit shell overrides and platform defaults", () => {
  assert.equal(resolveCommandShell({ platform: "linux", env: { SHELL: "/bin/bash" } }), false);
  assert.equal(resolveCommandShell({ platform: "win32", shell: false, env: { SHELL: "powershell.exe" } }), false);
  assert.equal(
    resolveCommandShell({
      platform: "win32",
      env: { SHELL: "powershell.exe", ComSpec: "C:\\Windows\\System32\\cmd.exe" }
    }),
    "C:\\Windows\\System32\\cmd.exe"
  );
});

test("isShellPolicyRejection identifies PowerShell execution policy errors without false positives", () => {
  assert.equal(isShellPolicyRejection(SAMPLE_PS_POLICY_ERROR), true);
  assert.equal(isShellPolicyRejection("PSSecurityException"), true);
  assert.equal(isShellPolicyRejection("UnauthorizedAccess: codex.ps1 blocked"), true);
  assert.equal(isShellPolicyRejection("spawn codex ENOENT"), false);
  assert.equal(isShellPolicyRejection("'codex' is not recognized as an internal or external command"), false);
  assert.equal(isShellPolicyRejection("UnauthorizedAccess: invalid API key"), false);
});

test("binaryAvailable distinguishes policy rejection from missing binaries", () => {
  const policyResult = binaryAvailable("codex", ["--version"], {
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 1,
        signal: null,
        stdout: "",
        stderr: SAMPLE_PS_POLICY_ERROR,
        error: null
      };
    }
  });
  assert.equal(policyResult.available, false);
  assert.equal(policyResult.reason, "policy-rejected");
  assert.match(policyResult.detail, /PSSecurityException/);

  const missingResult = binaryAvailable("codex", ["--version"], {
    runCommandImpl(command, args) {
      const error = /** @type {NodeJS.ErrnoException} */ (new Error("spawn codex ENOENT"));
      error.code = "ENOENT";
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error
      };
    }
  });
  assert.equal(missingResult.available, false);
  assert.equal(missingResult.reason, "not-found");
});

test("getCodexAvailability and formatCodexUnavailableError distinguish policy rejection from missing CLI", () => {
  const availability = getCodexAvailability(process.cwd(), {
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 1,
        signal: null,
        stdout: "",
        stderr: SAMPLE_PS_POLICY_ERROR,
        error: null
      };
    }
  });

  assert.equal(availability.available, false);
  assert.equal(availability.reason, "policy-rejected");

  const policyMessage = formatCodexUnavailableError(availability);
  assert.match(policyMessage, /shell execution policy/i);
  assert.match(policyMessage, /codex\.cmd/i);
  assert.doesNotMatch(policyMessage, /Codex CLI is not installed/i);

  const missingMessage = formatCodexUnavailableError({ available: false, reason: "not-found", detail: "not found" });
  assert.match(missingMessage, /Codex CLI is not installed/i);
});

test(
  "binaryAvailable launches .cmd shim instead of .ps1 when SHELL points to PowerShell on Windows",
  { skip: process.platform !== "win32" },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-ps1-policy-"));
    try {
      fs.writeFileSync(path.join(dir, "fake-codex.ps1"), "Write-Output \"from-ps1\"\n");
      fs.writeFileSync(path.join(dir, "fake-codex.cmd"), "@echo codex-cli 0.165.0\r\n");

      const result = binaryAvailable("fake-codex", ["--version"], {
        env: {
          ...process.env,
          SHELL: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          PATH: `${dir};${process.env.PATH ?? ""}`
        }
      });

      assert.equal(result.available, true, result.detail);
      assert.equal(result.reason, "ok");
      assert.equal(result.detail, "codex-cli 0.165.0");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
