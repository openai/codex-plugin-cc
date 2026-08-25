
import test from "node:test";
import assert from "node:assert/strict";
import { createSchedulerState, deriveOrchestrationStatus, getReadyPackageIds, markPackageCompleted, markPackageFailed, markPackageReady, markPackageRunning, propagateBlockedPackages } from "../plugins/codex/scripts/orchestration/scheduler.mjs";
const plan = { packages: [ { id: "a", dependencies: [], optional: false }, { id: "b", dependencies: [], optional: true }, { id: "c", dependencies: ["a"], optional: false } ] };
test("schedules dependency-ready packages", () => { let state = createSchedulerState(plan); assert.deepEqual(getReadyPackageIds(state), ["a", "b"]); state = markPackageReady(state, "a"); state = markPackageRunning(state, "a", 1); state = markPackageCompleted(state, "a"); assert.deepEqual(getReadyPackageIds(state), ["b", "c"]); });
test("blocks descendants of failed dependencies", () => { let state = createSchedulerState(plan); state = markPackageReady(state, "a"); state = markPackageRunning(state, "a", 1); state = markPackageFailed(state, "a", "x"); state = propagateBlockedPackages(state); assert.equal(state.packages.c.status, "blocked"); assert.equal(deriveOrchestrationStatus(state), "running"); });
