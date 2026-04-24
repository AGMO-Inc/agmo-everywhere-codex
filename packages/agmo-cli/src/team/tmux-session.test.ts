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

test("buildWorkerCodexArgs inherits madmax autonomy from launch env", () => {
  const previous = process.env.AGMO_CODEX_AUTONOMY_MODE;
  process.env.AGMO_CODEX_AUTONOMY_MODE = "madmax";
  try {
    assert.deepEqual(buildWorkerCodexArgs("hello"), [
      "codex",
      "--dangerously-bypass-approvals-and-sandbox",
      "--no-alt-screen",
      "hello"
    ]);
  } finally {
    if (previous === undefined) {
      delete process.env.AGMO_CODEX_AUTONOMY_MODE;
    } else {
      process.env.AGMO_CODEX_AUTONOMY_MODE = previous;
    }
  }
});
