import assert from "node:assert/strict";
import test from "node:test";
import { computeTeamLayoutPlan } from "./layout-planner.js";

test("computeTeamLayoutPlan preserves small team main-vertical shape", () => {
  const plan = computeTeamLayoutPlan(160, 48, 2, { hud: true });
  assert.equal(plan.choice, "leader-left-stack-right");
  assert.equal(plan.health, "ok");
  assert.equal(plan.columns, 1);
  assert.equal(plan.selectedReason, "small_team_stack_fits");
  assert.equal(plan.metrics.usableHeight, 42);
  assert.equal(plan.metrics.visibleWorkerCapacity, 2);
  assert.equal(plan.metrics.overflowWorkers, 0);
  assert.equal(plan.metrics.workersMeetMinimumHeight, true);
});

test("computeTeamLayoutPlan chooses grid for wider many-worker teams", () => {
  const plan = computeTeamLayoutPlan(220, 60, 6, { hud: true });
  assert.equal(plan.choice, "leader-left-grid-right");
  assert.ok(plan.columns > 1);
  assert.ok(plan.rows > 1);
  assert.equal(plan.selectedReason, "grid_preserves_worker_capacity");
  assert.ok((plan.metrics.visibleWorkerCapacity ?? 0) >= 6);
  assert.equal(plan.metrics.overflowWorkers, 0);
});

test("computeTeamLayoutPlan reports degraded when geometry is unavailable", () => {
  const plan = computeTeamLayoutPlan(null, null, 3);
  assert.equal(plan.health, "degraded");
  assert.equal(plan.selectedReason, "geometry_unavailable_fallback");
  assert.equal(plan.metrics.usableHeight, null);
  assert.equal(plan.metrics.visibleWorkerCapacity, null);
  assert.equal(plan.metrics.overflowWorkers, 3);
  assert.deepEqual(plan.warnings, ["tmux_geometry_unavailable"]);
});

test("computeTeamLayoutPlan honors tiled preset", () => {
  const plan = computeTeamLayoutPlan(120, 40, 4, { preset: "tiled" });
  assert.equal(plan.choice, "tiled");
  assert.equal(plan.preset, "tiled");
  assert.equal(plan.selectedReason, "explicit_tiled_preset");
  assert.equal(plan.leaderWidth, null);
  assert.equal(plan.metrics.availableWorkerWidth, 120);
});

test("computeTeamLayoutPlan keeps no-worker plans healthy with capacity metrics", () => {
  const plan = computeTeamLayoutPlan(100, 30, 0, { hud: true });
  assert.equal(plan.choice, "leader-left-stack-right");
  assert.equal(plan.health, "ok");
  assert.equal(plan.selectedReason, "no_workers");
  assert.equal(plan.metrics.requestedWorkers, 0);
  assert.equal(plan.metrics.overflowWorkers, 0);
});

test("computeTeamLayoutPlan drops HUD when compact capacity improves", () => {
  const plan = computeTeamLayoutPlan(160, 20, 2, { hud: true });
  assert.equal(plan.choice, "compact-no-hud");
  assert.equal(plan.hudHeight, 0);
  assert.equal(plan.selectedReason, "compact_window_drops_hud");
  assert.equal(plan.metrics.hudDisabled, true);
  assert.equal(plan.metrics.visibleWorkerCapacity, 2);
  assert.equal(plan.metrics.overflowWorkers, 0);
  assert.ok(plan.warnings.includes("hud_disabled_for_compact_capacity"));
});

test("computeTeamLayoutPlan falls back to tiled when leader-left cannot fit workers", () => {
  const plan = computeTeamLayoutPlan(70, 40, 2, { hud: false });
  assert.equal(plan.choice, "tiled");
  assert.equal(plan.selectedReason, "tiled_best_capacity");
  assert.equal(plan.metrics.visibleWorkerCapacity, 2);
  assert.equal(plan.metrics.overflowWorkers, 0);
});

test("computeTeamLayoutPlan honors explicit main-vertical preset", () => {
  const plan = computeTeamLayoutPlan(220, 60, 6, { preset: "main-vertical", hud: true });
  assert.equal(plan.choice, "leader-left-stack-right");
  assert.equal(plan.selectedReason, "explicit_main_vertical_preset");
  assert.equal(plan.columns, 1);
});
