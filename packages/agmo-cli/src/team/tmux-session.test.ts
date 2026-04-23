import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkerCodexArgs } from "./tmux-session.js";

test("buildWorkerCodexArgs injects --yolo for tmux workers", () => {
  assert.deepEqual(buildWorkerCodexArgs("hello"), ["codex", "--yolo", "--no-alt-screen", "hello"]);
});
