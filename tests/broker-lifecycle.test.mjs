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

// Caught in review: this is a real reachable state, not a hypothetical --
// it's precisely what the old (pre-fix) lookup behavior could leave behind:
// a broker registered under one root, then a *different* broker later
// registered under the other root because the old code couldn't see the
// first one. Only one of the two brokers is ever the one actually acted on
// (whichever loadBrokerSession() returns) and torn down; clearBrokerSession
// must not delete the other root's record too, since that broker was never
// shut down and losing its record would make it permanently untrackable.
test("clearBrokerSession does not delete a distinct session recorded under the other root", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();

  withPluginDataDir(null, () => {
    saveBrokerSession(workspace, { endpoint: "fallback-endpoint", pid: 1111 });
  });
  withPluginDataDir(pluginDataDir, () => {
    saveBrokerSession(workspace, { endpoint: "plugin-data-endpoint", pid: 2222 });
  });

  withPluginDataDir(pluginDataDir, () => {
    // loadBrokerSession() would return (and a caller would tear down) the
    // plugin-data-root session, since it's checked first.
    clearBrokerSession(workspace);
  });

  // The fallback-root session must survive untouched -- visible whether
  // checked directly (env unset) or as the sole remaining candidate (env
  // set, since the plugin-data one is now gone). If clearBrokerSession had
  // wrongly deleted it too, this would come back null or the check with the
  // env set would find nothing.
  withPluginDataDir(null, () => {
    assert.deepEqual(loadBrokerSession(workspace), { endpoint: "fallback-endpoint", pid: 1111 });
  });
  withPluginDataDir(pluginDataDir, () => {
    assert.deepEqual(loadBrokerSession(workspace), { endpoint: "fallback-endpoint", pid: 1111 });
  });
});
