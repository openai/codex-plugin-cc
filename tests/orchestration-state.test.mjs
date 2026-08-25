
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir } from "./helpers.mjs";
import { createOrchestrationState, listOrchestrations, loadOrchestrationState, resolveOrchestrationReference, updateOrchestrationState } from "../plugins/codex/scripts/orchestration/state-store.mjs";
const plan = { objective: "state", packages: [{ id: "pkg-a", title: "A" }], budget: { timeoutMinutes: 15 } };
test("persists orchestration state atomically", async () => { const workspace = makeTempDir(); const pluginDataDir = makeTempDir(); const state = await createOrchestrationState(workspace, plan, { claudeSessionId: "s" }, { pluginDataDir }); await updateOrchestrationState(workspace, state.id, (value) => { value.status = "running"; return value; }, { pluginDataDir }); assert.equal(loadOrchestrationState(workspace, state.id, { pluginDataDir }).status, "running"); assert.equal(listOrchestrations(workspace, { pluginDataDir }).length, 1); assert.equal(resolveOrchestrationReference(workspace, "pkg-a", { pluginDataDir }).packageId, "pkg-a"); });
