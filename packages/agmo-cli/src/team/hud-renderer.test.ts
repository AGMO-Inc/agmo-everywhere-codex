import assert from "node:assert/strict";
import test from "node:test";
import { renderTeamHud, type TeamHudRenderContext } from "./hud-renderer.js";
import {
  ellipsize,
  sanitizeTerminalText,
  stripAnsi,
  visibleLength,
  wrapLine
} from "./terminal-format.js";

function context(): TeamHudRenderContext {
  return {
    teamName: "demo\u0007team",
    snapshot: {
      team_name: "demo",
      checked_at: "2026-05-27T00:00:00.000Z",
      stale_after_ms: 120000,
      dead_after_ms: 600000,
      active_workers: 1,
      healthy_workers: 1,
      stale_workers: 0,
      dead_workers: 0,
      workers: [
        {
          worker_name: "worker-1",
          role: "agmo-executor",
          status_state: "working",
          current_task_id: "task-1",
          heartbeat_at: "2026-05-27T00:00:00.000Z",
          ms_since_heartbeat: 2000,
          pid_alive: true,
          heartbeat_alive_flag: true,
          turn_count: 3,
          health: "healthy",
          pending_dispatch_count: 1,
          mailbox_message_count: 0,
          pane_id: "%2",
          claim_at_risk: false,
          reasons: []
        }
      ],
      leader: { role: "leader", pane_id: "%1", session_id: "$1", health: "live", reasons: [] },
      hud: { role: "hud", pane_id: "%3", session_id: "$1", health: "live", reasons: [] },
      tmux_health: {
        transport: "tmux",
        leader: "live",
        hud: "live",
        workers: {
          "worker-1": "live"
        },
        layout: "ok",
        retry_pending: 0,
        retry_manual_required: 0,
        orphan_warnings: []
      }
    },
    status: {
      config: {} as TeamHudRenderContext["status"]["config"],
      manifest: {} as TeamHudRenderContext["status"]["manifest"],
      phase: {} as TeamHudRenderContext["status"]["phase"],
      workers: [],
      mailbox: {},
      dispatch_requests: [],
      tasks: [
        {
          id: "task-1",
          subject: "finish renderer",
          description: "",
          owner: "worker-1",
          status: "in_progress",
          version: 1,
          created_at: "2026-05-27T00:00:00.000Z",
          updated_at: "2026-05-27T00:00:00.000Z"
        }
      ]
    },
    taskCounts: { pending: 0, in_progress: 1, blocked: 0, completed: 0, failed: 0 },
    pendingDispatch: 1,
    activeLeaderAlerts: 0,
    openLoads: { "worker-1": 1 },
    openLoadDelta: 0,
    topActions: ["retry-dispatch"]
  };
}

test("terminal helpers sanitize and measure visible text", () => {
  assert.equal(sanitizeTerminalText("a\u0007b\tc"), "a?b c");
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
  assert.equal(visibleLength("\x1b[31mred\x1b[0m"), 3);
  assert.equal(ellipsize("abcdef", 4), "abc.");
  assert.deepEqual(wrapLine("alpha beta gamma", 10), ["alpha beta", "gamma"]);
});

test("renderTeamHud supports presets, clipping, and no-color output", () => {
  const minimal = renderTeamHud(context(), {
    preset: "minimal",
    maxWidth: 60,
    color: "never"
  });
  assert.match(minimal, /AGMO HUD/);
  assert.doesNotMatch(minimal, /\x1b\[/);
  assert.doesNotMatch(minimal, /Workers/);

  const full = renderTeamHud(context(), {
    preset: "full",
    maxWidth: 42,
    maxLines: 7,
    color: "never"
  });
  assert.match(full, /demo\?team/);
  assert.match(full, /Workers|clipped/);
  for (const line of full.trimEnd().split("\n")) {
    assert.ok(visibleLength(line) <= 42, line);
  }
});

test("renderTeamHud can force color", () => {
  const rendered = renderTeamHud(context(), { color: "always" });
  assert.match(rendered, /\x1b\[/);
});
