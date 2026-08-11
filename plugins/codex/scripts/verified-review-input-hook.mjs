#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import {
  VERIFIED_REVIEW_INPUT_MARKER,
  captureVerifiedReviewInput,
  isVerifiedReviewCommand
} from "./lib/verified-review-input.mjs";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function main() {
  const input = readHookInput();
  if (input.hook_event_name !== "UserPromptExpansion" || !isVerifiedReviewCommand(input.command_name)) {
    return;
  }

  const capture = captureVerifiedReviewInput({
    cwd: input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    sessionId: input.session_id,
    rawArguments: input.command_args
  });
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptExpansion",
        additionalContext: `${VERIFIED_REVIEW_INPUT_MARKER}=${capture.id}`
      }
    })}\n`
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
