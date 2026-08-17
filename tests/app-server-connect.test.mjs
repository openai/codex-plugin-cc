import test from "node:test";
import assert from "node:assert/strict";

import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";

/** Reject rather than hang, so a wedged connect fails the test instead of stalling the run. */
function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

test("connect reports a malformed broker endpoint instead of hanging", async () => {
  // parseBrokerEndpoint throws before a socket exists, so cleanup has no transport to wait on.
  // Closing then awaited an exit nothing would ever report, and connect() never settled — a
  // configuration mistake turned into a hang.
  await assert.rejects(
    () =>
      withDeadline(
        CodexAppServerClient.connect(process.cwd(), { brokerEndpoint: "not-an-endpoint" }),
        5000,
        "connect"
      ),
    /Unsupported broker endpoint/
  );
});

test("connect reports an empty broker endpoint instead of hanging", async () => {
  await assert.rejects(
    () =>
      withDeadline(
        CodexAppServerClient.connect(process.cwd(), { brokerEndpoint: "unix:" }),
        5000,
        "connect"
      ),
    /missing its path/
  );
});
