import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkerCodexArgs, destroyWorkerPanes } from "./tmux-session.js";

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

test("destroyWorkerPanes reports killed, failed, and skipped panes", () => {
  const calls: string[][] = [];
  const result = destroyWorkerPanes(["%1", "%2", "pane-3"], (args) => {
    calls.push(args);
    if (args[2] === "%2") {
      return {
        ok: false,
        stdout: "",
        stderr: "no such pane"
      };
    }

    return {
      ok: true,
      stdout: "",
      stderr: ""
    };
  });

  assert.deepEqual(calls, [
    ["kill-pane", "-t", "%1"],
    ["kill-pane", "-t", "%2"]
  ]);
  assert.equal(result.killed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.panes, [
    {
      pane_id: "%1",
      status: "killed"
    },
    {
      pane_id: "%2",
      status: "failed",
      error: "no such pane"
    },
    {
      pane_id: "pane-3",
      status: "skipped",
      error: "invalid tmux pane id"
    }
  ]);
});
