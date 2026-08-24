import test from "node:test";
import assert from "node:assert/strict";

import { prepareSpawnCommand, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

test("prepareSpawnCommand preserves Windows cmd argument boundaries", () => {
  const invocation = prepareSpawnCommand(
    "codex",
    ["-c", "key=value with spaces", "-c", "url=https://example.test?a=1&b=2"],
    { platform: "win32", shell: true }
  );

  assert.deepEqual(invocation, {
    command:
      'codex ^"-c^" ^"key=value^ with^ spaces^" ^"-c^" ^"url=https://example.test^?a=1^&b=2^"',
    args: [],
    shell: true
  });
});

test("prepareSpawnCommand keeps percent signs out of cmd.exe source", () => {
  const original = {
    command: "codex",
    args: ["-c", "base_url=https://example.test/%2Ftenant%2F/v1", "-c", "token=%NAME%"]
  };
  const invocation = prepareSpawnCommand(original.command, original.args, { platform: "win32", shell: true });

  assert.equal(invocation.command, "powershell.exe");
  assert.equal(invocation.shell, false);
  assert.deepEqual(invocation.args.slice(0, -1), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command"
  ]);

  const script = invocation.args.at(-1);
  assert.doesNotMatch(script, /%2F|%NAME%/);
  const payload = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
  assert.ok(payload);
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64").toString("utf8")), original);
});

test("prepareSpawnCommand invokes configured PowerShell without POSIX quoting", () => {
  const shell = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const original = { command: "codex", args: ["-c", "key=value with spaces", "--version"] };
  const invocation = prepareSpawnCommand(original.command, original.args, { platform: "win32", shell });

  assert.equal(invocation.command, shell);
  assert.equal(invocation.shell, false);
  const script = invocation.args.at(-1);
  assert.doesNotMatch(script, /'codex'|'--version'/);
  const payload = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
  assert.ok(payload);
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64").toString("utf8")), original);
});

test("prepareSpawnCommand preserves Windows Git Bash argument boundaries", () => {
  const invocation = prepareSpawnCommand("codex", ["-c", "key=value with spaces", "it's literal"], {
    platform: "win32",
    shell: "C:\\Program Files\\Git\\bin\\bash.exe"
  });

  assert.deepEqual(invocation, {
    command: `'codex' '-c' 'key=value with spaces' 'it'\\''s literal'`,
    args: [],
    shell: "C:\\Program Files\\Git\\bin\\bash.exe"
  });
});

test("prepareSpawnCommand honors an explicit shell opt-out on Windows", () => {
  assert.deepEqual(prepareSpawnCommand("git", ["rev-parse", "main&branch"], { platform: "win32", shell: false }), {
    command: "git",
    args: ["rev-parse", "main&branch"],
    shell: false
  });
});

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
