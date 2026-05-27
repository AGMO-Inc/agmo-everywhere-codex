import assert from "node:assert/strict";
import test from "node:test";
import { computeTeamLayoutPlan } from "./layout-planner.js";

test("computeTeamLayoutPlan preserves small team main-vertical shape", () => {
  const plan = computeTeamLayoutPlan(160, 48, 2, { hud: true });
  assert.equal(plan.choice, "leader-left-stack-right");
  assert.equal(plan.health, "ok");
  assert.equal(plan.columns, 1);
});

test("computeTeamLayoutPlan chooses grid for wider many-worker teams", () => {
  const plan = computeTeamLayoutPlan(220, 60, 6, { hud: true });
  assert.equal(plan.choice, "leader-left-grid-right");
  assert.ok(plan.columns > 1);
  assert.ok(plan.rows > 1);
});

test("computeTeamLayoutPlan reports degraded when geometry is unavailable", () => {
  const plan = computeTeamLayoutPlan(null, null, 3);
  assert.equal(plan.health, "degraded");
  assert.deepEqual(plan.warnings, ["tmux_geometry_unavailable"]);
});

test("computeTeamLayoutPlan honors tiled preset", () => {
  const plan = computeTeamLayoutPlan(120, 40, 4, { preset: "tiled" });
  assert.equal(plan.choice, "tiled");
  assert.equal(plan.preset, "tiled");
});
