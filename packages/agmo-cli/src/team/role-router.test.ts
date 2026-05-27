import assert from "node:assert/strict";
import test from "node:test";
import { routeTaskToRole } from "./role-router.js";

test("routeTaskToRole characterizes representative task routing", () => {
  assert.deepEqual(routeTaskToRole("Implement the team status command"), {
    role: "agmo-executor",
    intent: "implementation",
    confidence: "medium",
    reason: "implementation-oriented keywords detected",
  });

  assert.deepEqual(routeTaskToRole("Verify regression coverage for lifecycle smoke"), {
    role: "agmo-verifier",
    intent: "verification",
    confidence: "medium",
    reason: "verification-oriented keywords detected",
  });

  assert.deepEqual(routeTaskToRole("Plan the rollout strategy"), {
    role: "agmo-planner",
    intent: "planning",
    confidence: "medium",
    reason: "planning-oriented keywords detected",
  });

  assert.deepEqual(routeTaskToRole("Create a vault note from the docs research"), {
    role: "agmo-wisdom",
    intent: "knowledge",
    confidence: "medium",
    reason: "knowledge/vault-oriented keywords detected",
  });

  assert.deepEqual(routeTaskToRole("Handle the next request"), {
    role: "agmo-executor",
    intent: "implementation",
    confidence: "low",
    reason: "fallback implementation lane",
  });
});
