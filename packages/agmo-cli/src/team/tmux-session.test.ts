import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkerCodexArgs,
  buildHudCommand,
  destroyWorkerPanes,
  findHudPaneIds,
  listTmuxPanes,
  readAgmoHudPaneOwner,
  reapOrphanHudPanes
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
      stdout: "$1\tteam\t@2\t%3\t1\t0\tzsh\tzsh\tleader\t120\t40\t0\t0\t200\t60\n$1\tteam\t@2\t%4\t0\t1\tcodex\tcodex\tworker\t80\t20\t120\t0\t200\t60\n",
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
      command: "zsh",
      start_command: "zsh",
      title: "leader",
      pane_width: 120,
      pane_height: 40,
      pane_left: 0,
      pane_top: 0,
      window_width: 200,
      window_height: 60
    },
    {
      session_id: "$1",
      session_name: "team",
      window_id: "@2",
      pane_id: "%4",
      active: false,
      dead: true,
      command: "codex",
      start_command: "codex",
      title: "worker",
      pane_width: 80,
      pane_height: 20,
      pane_left: 120,
      pane_top: 0,
      window_width: 200,
      window_height: 60
    }
  ]);
});

test("HUD command uses CLI watch mode with owner tags", () => {
  const command = buildHudCommand({
    teamName: "demo",
    projectRoot: "/repo",
    cliEntryPath: "/repo/dist/cli/index.js",
    refreshMs: 500,
    clearScreen: false,
    leaderPaneId: "%1",
    sessionId: "$1",
    preset: "minimal",
    width: 80,
    maxLines: 10,
    color: "never"
  });

  assert.match(command, /AGMO_TMUX_HUD_OWNER=1/);
  assert.match(command, /team/);
  assert.match(command, /hud/);
  assert.match(command, /--watch/);
  assert.doesNotMatch(command, /while true/);
  assert.doesNotMatch(command, /clear;/);
  assert.match(command, /--no-clear/);
});

test("HUD owner helpers parse tagged panes and find reusable panes", () => {
  const pane = {
    session_id: "$1",
    session_name: "team",
    window_id: "@1",
    pane_id: "%2",
    active: false,
    dead: false,
    command: "zsh",
    start_command:
      "cd '/repo'; export AGMO_TEAM_NAME='demo'; export AGMO_TMUX_HUD_OWNER=1; export AGMO_TMUX_HUD_LEADER_PANE='%1'; export AGMO_TMUX_SESSION_ID='$1'; exec node '/repo/dist/cli/index.js' 'team' 'hud' 'demo' '--watch'",
    title: "agmo:hud:demo"
  };
  assert.deepEqual(readAgmoHudPaneOwner(pane), {
    owned: true,
    teamName: "demo",
    leaderPaneId: "%1",
    sessionId: "$1"
  });
  assert.deepEqual(findHudPaneIds([pane], { teamName: "demo", leaderPaneId: "%1", sessionId: "$1" }), ["%2"]);
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

test("reapOrphanHudPanes kills only owned HUD panes with missing tagged leaders", () => {
  const calls: string[][] = [];
  const ownedHudCommand = (leaderPaneId: string, sessionId = "$expected") =>
    `cd '/repo'; export AGMO_TEAM_NAME='demo'; export AGMO_TMUX_HUD_OWNER=1; export AGMO_TMUX_HUD_LEADER_PANE='${leaderPaneId}'; export AGMO_TMUX_SESSION_ID='${sessionId}'; exec node '/repo/dist/cli/index.js' 'team' 'hud' 'demo' '--watch'`;

  const result = reapOrphanHudPanes(
    {
      teamName: "demo",
      sessionId: "$expected",
      leaderPaneId: "%1"
    },
    (args) => {
      calls.push(args);
      if (args[0] === "list-panes") {
        return {
          ok: true,
          stdout: [
            "$expected\tteam\t@1\t%1\t1\t0\tzsh\tzsh\tagmo:leader:demo",
            `$expected\tteam\t@1\t%2\t0\t0\tzsh\t${ownedHudCommand("%404")}\tagmo:hud:demo`,
            `$expected\tteam\t@1\t%3\t0\t0\tzsh\t${ownedHudCommand("%1")}\tagmo:hud:demo`,
            `$other\tother\t@2\t%4\t0\t0\tzsh\t${ownedHudCommand("%404", "$other")}\tagmo:hud:demo`,
            "$expected\tteam\t@1\t%5\t0\t0\tzsh\tzsh\tagmo:hud:demo",
            `$expected\tteam\t@1\t%6\t0\t0\tzsh\t${ownedHudCommand("%404")}\tagmo:hud:demo`
          ].join("\n"),
          stderr: ""
        };
      }
      if (args[0] === "display-message") {
        return {
          ok: true,
          stdout: "$expected\tteam\t@1\t%6",
          stderr: ""
        };
      }
      return {
        ok: true,
        stdout: "",
        stderr: ""
      };
    }
  );

  assert.deepEqual(calls.filter((args) => args[0] === "kill-pane"), [["kill-pane", "-t", "%2"]]);
  assert.deepEqual(result.performed.map((entry) => entry.pane_id), ["%2"]);
  assert.equal(result.refused.find((entry) => entry.pane_id === "%4")?.reason, "foreign_session");
  assert.equal(result.refused.find((entry) => entry.pane_id === "%6")?.reason, "current_pane_protected");
  assert.equal(result.skipped.find((entry) => entry.pane_id === "%3")?.reason, "owner_leader_live");
  assert.equal(result.skipped.find((entry) => entry.pane_id === "%5")?.reason, "owner_leader_tag_missing");
});

test("reapOrphanHudPanes dry-run reports plans without tmux mutation", () => {
  const calls: string[][] = [];
  const result = reapOrphanHudPanes(
    {
      teamName: "demo",
      sessionId: "$expected",
      leaderPaneId: "%1",
      dryRun: true
    },
    (args) => {
      calls.push(args);
      if (args[0] === "list-panes") {
        return {
          ok: true,
          stdout:
            "$expected\tteam\t@1\t%2\t0\t0\tzsh\tcd '/repo'; export AGMO_TEAM_NAME='demo'; export AGMO_TMUX_HUD_OWNER=1; export AGMO_TMUX_HUD_LEADER_PANE='%404'; export AGMO_TMUX_SESSION_ID='$expected'; exec node '/repo/dist/cli/index.js' 'team' 'hud' 'demo' '--watch'\tagmo:hud:demo",
          stderr: ""
        };
      }
      if (args[0] === "display-message") {
        return {
          ok: true,
          stdout: "$expected\tteam\t@1\t%1",
          stderr: ""
        };
      }
      return {
        ok: true,
        stdout: "",
        stderr: ""
      };
    }
  );

  assert.deepEqual(calls.filter((args) => args[0] === "kill-pane"), []);
  assert.deepEqual(result.planned.map((entry) => entry.pane_id), ["%2"]);
  assert.equal(result.performed.length, 0);
});
