import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkerCodexArgs } from "./tmux-session.js";

test("buildWorkerCodexArgs injects --full-auto for tmux workers", () => {
  assert.deepEqual(buildWorkerCodexArgs("hello"), [
    "codex",
    "--full-auto",
    "--no-alt-screen",
    "hello"
  ]);
});
