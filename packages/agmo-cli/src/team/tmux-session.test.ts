import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkerCodexArgs,
  destroyWorkerPanes,
  listTmuxPanes
} from "./tmux-session.js";

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
    if (args[0] === "list-panes") {
      return {
        ok: true,
        stdout: "",
        stderr: ""
      };
    }
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

  assert.deepEqual(calls.filter((args) => args[0] === "kill-pane"), [
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
      reason: "invalid_tmux_pane_id",
      error: "invalid tmux pane id"
    }
  ]);
});

test("listTmuxPanes parses pane topology output", () => {
  const panes = listTmuxPanes((args) => {
    assert.equal(args[0], "list-panes");
    return {
      ok: true,
      stdout: "$1\tteam\t@2\t%3\t1\t0\tzsh\n$1\tteam\t@2\t%4\t0\t1\tcodex\n",
      stderr: ""
    };
  });

  assert.deepEqual(panes, [
    {
      session_id: "$1",
      session_name: "team",
      window_id: "@2",
      pane_id: "%3",
      active: true,
      dead: false,
      command: "zsh"
    },
    {
      session_id: "$1",
      session_name: "team",
      window_id: "@2",
      pane_id: "%4",
      active: false,
      dead: true,
      command: "codex"
    }
  ]);
});

test("destroyWorkerPanes refuses protected and foreign-session panes", () => {
  const calls: string[][] = [];
  const result = destroyWorkerPanes(
    ["%1", "%2", "%3", "%4"],
    (args) => {
      calls.push(args);
      if (args[0] === "list-panes") {
        return {
          ok: true,
          stdout: "$expected\tteam\t@1\t%1\t1\t0\tzsh\n$other\tother\t@2\t%2\t1\t0\tzsh\n$expected\tteam\t@1\t%3\t0\t0\tcodex\n",
          stderr: ""
        };
      }
      return {
        ok: true,
        stdout: "",
        stderr: ""
      };
    },
    {
      expectedSessionId: "$expected",
      leaderPaneId: "%1",
      currentPaneId: "%1"
    }
  );

  assert.deepEqual(calls.filter((args) => args[0] === "kill-pane"), [
    ["kill-pane", "-t", "%3"]
  ]);
  assert.equal(result.killed, 1);
  assert.equal(result.skipped, 3);
  assert.equal(result.panes.find((pane) => pane.pane_id === "%1")?.reason, "topology_guard");
  assert.match(result.panes.find((pane) => pane.pane_id === "%2")?.error ?? "", /another tmux session/);
  assert.match(result.panes.find((pane) => pane.pane_id === "%4")?.error ?? "", /not found/);
});
