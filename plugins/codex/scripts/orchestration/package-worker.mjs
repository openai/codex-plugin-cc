#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { CodexAppServerClient } from "../lib/app-server.mjs";
import { runAppServerTurnWithClient } from "../lib/codex.mjs";
import { parseStructuredOutput } from "../lib/structured-output.mjs";
import { buildReadOnlyPackagePrompt } from "./package-prompt.mjs";
import { readPackageResultSchema, validatePackageResult } from "./result-contract.mjs";

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(error) {
  send({
    type: "error",
    error: {
      message: error instanceof Error ? error.message : String(error),
      code: error?.code ?? null,
      transient: Boolean(error?.transient)
    }
  });
  process.stdin.removeAllListeners("data");
  process.stdin.destroy();
  process.exitCode = 1;
}

async function main() {
  const specFile = process.argv[2];
  if (!specFile) throw new Error("Usage: package-worker.mjs <spec-file>");

  const request = JSON.parse(fs.readFileSync(specFile, "utf8"));
  const invalidEndpoint = process.platform === "win32"
    ? `pipe:\\\\.\\pipe\\codex-orchestration-direct-${process.pid}-${crypto.randomUUID()}`
    : `unix:${path.join(os.tmpdir(), `codex-orchestration-direct-${process.pid}-${crypto.randomUUID()}.sock`)}`;
  process.env.CODEX_COMPANION_APP_SERVER_ENDPOINT = invalidEndpoint;

  let threadId = null;
  let turnId = null;
  let nativeChildren = 0;
  let nativeChildPeak = 0;
  let boundaryError = null;
  const childThreadIds = new Set();
  const client = await CodexAppServerClient.connect(request.workspaceRoot, {
    disableBroker: true,
    env: process.env
  });

  let interruptRequested = false;
  let interruptSent = false;
  const sendInterruptIfReady = () => {
    if (!interruptRequested || interruptSent || !threadId || !turnId) return;
    interruptSent = true;
    client.request("turn/interrupt", { threadId, turnId }).catch(() => {
      interruptSent = false;
    });
  };

  process.stdin.setEncoding("utf8");
  let controlBuffer = "";
  process.stdin.on("data", (chunk) => {
    controlBuffer += chunk;
    let index = controlBuffer.indexOf("\n");
    while (index !== -1) {
      const line = controlBuffer.slice(0, index);
      controlBuffer = controlBuffer.slice(index + 1);
      index = controlBuffer.indexOf("\n");
      try {
        const message = JSON.parse(line);
        if (message.type === "interrupt") {
          interruptRequested = true;
          sendInterruptIfReady();
        }
      } catch {}
    }
  });

  const result = await runAppServerTurnWithClient(client, request.workspaceRoot, {
    prompt: buildReadOnlyPackagePrompt(request.packageSpec, {
      dependencyResults: request.dependencyResults
    }),
    model: request.packageSpec.model.name,
    effort: request.packageSpec.model.effort,
    sandbox: "read-only",
    outputSchema: readPackageResultSchema(),
    onProgress(event) {
      const normalized = typeof event === "string" ? { message: event, phase: null } : event;
      threadId = normalized.threadId ?? threadId;
      turnId = normalized.turnId ?? turnId;
      sendInterruptIfReady();

      const message = String(normalized.message ?? "");
      if (/Starting subagent|Native child started/i.test(message)) {
        nativeChildren += 1;
        if (normalized.threadId && normalized.threadId !== threadId) {
          childThreadIds.add(normalized.threadId);
        }
      }
      if (/Subagent .* completed|Native child completed/i.test(message)) {
        nativeChildren = Math.max(0, nativeChildren - 1);
      }
      nativeChildPeak = Math.max(nativeChildPeak, nativeChildren);

      if (request.packageSpec.nativeSubagents.policy === "forbidden" && nativeChildren > 0) {
        boundaryError = Object.assign(
          new Error("Native children are forbidden for this package."),
          { code: "NATIVE_CHILD_POLICY_VIOLATION" }
        );
      }
      if (nativeChildren > request.packageSpec.nativeSubagents.maxChildren) {
        boundaryError = Object.assign(
          new Error(`Native child limit ${request.packageSpec.nativeSubagents.maxChildren} exceeded.`),
          { code: "NATIVE_CHILD_LIMIT_EXCEEDED" }
        );
      }

      send({
        type: "progress",
        event: {
          ...normalized,
          threadId,
          turnId,
          activeNativeChildren: nativeChildren,
          nativeChildPeak
        }
      });
    }
  });

  await client.close().catch(() => {});
  if (boundaryError) throw boundaryError;
  if (result.status !== 0) {
    const resultErrorMessage = result.error instanceof Error ? result.error.message : null;
    throw Object.assign(
      new Error(resultErrorMessage ?? result.stderr ?? "Codex package failed."),
      { code: "CODEX_PACKAGE_FAILED" }
    );
  }
  if ((result.touchedFiles ?? []).length > 0 || (result.fileChanges ?? []).length > 0) {
    throw Object.assign(
      new Error("Phase 1 read-only boundary violation: Codex reported file changes."),
      { code: "READ_ONLY_BOUNDARY_VIOLATION" }
    );
  }

  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.stderr
  });
  if (!parsed.parsed) {
    throw Object.assign(
      new Error(`Codex package returned invalid JSON: ${parsed.parseError}`),
      { code: "PACKAGE_RESULT_PARSE_ERROR" }
    );
  }

  const packageResult = validatePackageResult(parsed.parsed, request.packageSpec.id);
  send({
    type: "result",
    payload: {
      packageResult,
      threadId: result.threadId ?? threadId,
      turnId: result.turnId ?? turnId,
      nativeChildPeak,
      nativeChildThreadIds: result.nativeChildThreadIds ?? [...childThreadIds]
    }
  });

  process.stdin.removeAllListeners("data");
  process.stdin.destroy();
}

main().catch(fail);
