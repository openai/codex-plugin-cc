import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_SCRIPT = pathToFileURL(path.join(ROOT, "scripts", "build-session-hook.mjs")).href;
const OUTPUT = path.join(ROOT, "plugins", "codex", "scripts", "session-lifecycle-hook.mjs");

// The pure-JS compressor must not depend on native gzip or the build clock.
// Simulating OS bytes does not claim that this test runs on native Windows.
const DRIVER = `
import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import zlib from "node:zlib";

const operatingSystem = Number(process.argv[1]);
const timestamp = Number(process.argv[3]);
Date.now = () => timestamp;
const gzip = zlib.gzipSync;
let compressedFiles = 0;
zlib.gzipSync = (...args) => {
  const compressed = gzip(...args);
  compressed[9] = operatingSystem;
  compressedFiles += 1;
  return compressed;
};
syncBuiltinESMExports();
process.argv.push("--check");
await import(process.argv[2]);
assert.equal(compressedFiles, 0, "building the embedded WASMs must not use native gzip");
`;

for (const [operatingSystem, timestamp] of [[3, 946684800000], [0, 1893456000000]]) {
  test(`session hook bundle check ignores native gzip OS byte ${operatingSystem} and build time ${timestamp}`, () => {
    const original = fs.readFileSync(OUTPUT);
    const modified = fs.statSync(OUTPUT).mtimeMs;
    const result = run(process.execPath, [
      "--input-type=module", "--eval", DRIVER, String(operatingSystem), BUILD_SCRIPT, String(timestamp)
    ], { cwd: ROOT, env: { PATH: process.env.PATH } });

    assert.deepEqual(fs.readFileSync(OUTPUT), original, "--check must not rewrite the runtime hook");
    assert.equal(fs.statSync(OUTPUT).mtimeMs, modified, "--check must not touch the runtime hook");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Session hook bundle matches its pinned sources\./);
  });
}
