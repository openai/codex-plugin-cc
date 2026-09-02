import test from "node:test";
import assert from "node:assert/strict";

import { readStdinIfPiped } from "../plugins/codex/scripts/lib/fs.mjs";

function scriptedRead(steps, events = []) {
  return (fd, buffer, offset, length, position) => {
    events.push(["read", fd, offset, length, position]);
    const step = steps.shift();
    if (step instanceof Error) throw step;
    if (step == null) return 0;
    const bytes = Buffer.from(step);
    bytes.copy(buffer, offset);
    return bytes.length;
  };
}

function transient(code = "EAGAIN") {
  return Object.assign(new Error("resource temporarily unavailable"), { code });
}

test("readStdinIfPiped preserves bytes consumed before a transient read failure", () => {
  const events = [];
  const input = readStdinIfPiped({
    stdin: { isTTY: false, _handle: { setBlocking: (value) => events.push(["blocking", value]) } },
    readSync: scriptedRead(["first-", transient(), "second\n", null], events),
    waitForRetry: (delay) => events.push(["wait", delay]),
    chunkSize: 32
  });
  assert.equal(input, "first-second\n");
  assert.deepEqual(events[0], ["blocking", true]);
  assert.deepEqual(events.filter((event) => event[0] === "wait"), [["wait", 10]]);
});

test("readStdinIfPiped resets the transient retry budget after each successful chunk", () => {
  const steps = [];
  for (let index = 0; index < 10; index += 1) {
    steps.push(`chunk-${index};`, transient());
  }
  steps.push(null);
  const waits = [];
  const input = readStdinIfPiped({
    stdin: { isTTY: false },
    readSync: scriptedRead(steps),
    waitForRetry: (delay) => waits.push(delay),
    maxAttempts: 2
  });
  assert.equal(input, Array.from({ length: 10 }, (_, index) => `chunk-${index};`).join(""));
  assert.deepEqual(waits, Array(10).fill(10));
});

test("readStdinIfPiped keeps retrying transient reads until an open pipe progresses", () => {
  const waits = [];
  const steps = Array(20).fill(null).flatMap(() => [transient("EWOULDBLOCK")]);
  steps.push("eventual-data", null);
  const input = readStdinIfPiped({
    stdin: { isTTY: false },
    readSync: scriptedRead(steps),
    waitForRetry: (delay) => waits.push(delay),
    initialRetryDelayMs: 10,
    maxRetryDelayMs: 25
  });
  assert.equal(input, "eventual-data");
  assert.deepEqual(waits.slice(0, 5), [10, 20, 25, 25, 25]);
  assert.equal(waits.length, 20);
});

test("readStdinIfPiped surfaces non-transient read errors without retrying", () => {
  const error = Object.assign(new Error("bad descriptor"), { code: "EBADF" });
  let waits = 0;
  assert.throws(() => readStdinIfPiped({
    stdin: { isTTY: false },
    readSync() { throw error; },
    waitForRetry() { waits += 1; }
  }), (actual) => actual === error);
  assert.equal(waits, 0);
});

test("readStdinIfPiped ignores unsupported blocking mode and reads all chunks", () => {
  const input = readStdinIfPiped({
    stdin: { isTTY: false, _handle: { setBlocking() { throw new Error("unsupported"); } } },
    readSync: scriptedRead(["ordinary ", "pipe", null]),
    waitForRetry() { throw new Error("unexpected retry"); }
  });
  assert.equal(input, "ordinary pipe");
});

test("readStdinIfPiped returns empty input for a TTY without touching fd 0", () => {
  let reads = 0;
  const input = readStdinIfPiped({
    stdin: { isTTY: true },
    readSync() { reads += 1; return 0; }
  });
  assert.equal(input, "");
  assert.equal(reads, 0);
});
