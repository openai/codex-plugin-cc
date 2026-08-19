import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  clearBrokerSession,
  loadBrokerSession,
  saveBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

function withPluginDataDir(pluginDataDir, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginDataDir == null) {
    delete process.env.CLAUDE_PLUGIN_DATA;
  } else {
    process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  }
  try {
    return fn();
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

// A broker registered while CLAUDE_PLUGIN_DATA is unset (the tmpdir
// fallback) can later be looked up by an invocation where it's set, and
// resolves the same workspace slug/hash -- only the root differs, and a
// lookup that only checks the current invocation's root orphans the broker.
// This is the direction with concrete real-world evidence in the issue. The
// reverse isn't fixable this way: an unset env var carries no trace of what
// value it previously held, so there's nothing to check beyond the
// always-known tmpdir fallback.
test("loadBrokerSession finds a session registered without CLAUDE_PLUGIN_DATA when the current invocation has it set", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();

  withPluginDataDir(null, () => {
    saveBrokerSession(workspace, { endpoint: "test-endpoint", pid: 1234 });
  });

  const session = withPluginDataDir(pluginDataDir, () => loadBrokerSession(workspace));

  assert.deepEqual(session, { endpoint: "test-endpoint", pid: 1234 });
});

test("clearBrokerSession removes a session that was registered without CLAUDE_PLUGIN_DATA, from an invocation that has it set", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();

  withPluginDataDir(null, () => {
    saveBrokerSession(workspace, { endpoint: "test-endpoint", pid: 1234 });
  });

  withPluginDataDir(pluginDataDir, () => {
    clearBrokerSession(workspace);
    assert.equal(loadBrokerSession(workspace), null);
  });

  // Confirm it's gone from the root it was actually written under too, not
  // just invisible from the other one.
  withPluginDataDir(null, () => {
    assert.equal(loadBrokerSession(workspace), null);
  });
});
