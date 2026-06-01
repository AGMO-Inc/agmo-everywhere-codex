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

function renderSidecar(
  testContext: TeamHudRenderContext,
  options: { maxWidth?: number; maxLines?: number } = {}
): string {
  return renderTeamHud(testContext, {
    preset: "sidecar",
    maxWidth: options.maxWidth ?? 160,
    maxLines: options.maxLines ?? 8,
    color: "never"
  });
}

function assertInspectHintIsReadOnly(rendered: string): void {
  const inspectLines = rendered
    .trimEnd()
    .split("\n")
    .filter((line) => /\binspect(?:=|\b)/.test(line));
  assert.ok(inspectLines.length > 0, rendered);
  for (const line of inspectLines) {
    assert.doesNotMatch(line, /agmo team/);
    assert.doesNotMatch(
      line,
      /dispatch-retry|reclaim|--auto-nudge|layout repair|layout rebalance/
    );
  }
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
  assert.match(minimal, /layout=ok/);
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

test("renderTeamHud focused and full views surface worker and task diagnostics", () => {
  const testContext = context();
  testContext.snapshot.healthy_workers = 0;
  testContext.snapshot.stale_workers = 1;
  testContext.snapshot.workers[0] = {
    ...testContext.snapshot.workers[0],
    role: "agmo-verifier",
    status_state: "blocked",
    health: "stale",
    ms_since_heartbeat: 180000,
    mailbox_message_count: 2,
    pending_dispatch_count: 3,
    claim_at_risk: true,
    reasons: ["waiting\u0007on reviewer"]
  };
  testContext.snapshot.worker_panes = [
    {
      role: "worker",
      worker_name: "worker-1",
      pane_id: "%2",
      session_id: "$1",
      health: "missing",
      reasons: ["pane_not_found"]
    }
  ];
  testContext.status.tasks[0] = {
    ...testContext.status.tasks[0],
    claim: {
      owner: "worker-1",
      claimed_at: "2026-05-26T23:00:00.000Z"
    }
  };

  const focused = renderTeamHud(testContext, {
    preset: "focused",
    maxWidth: 180,
    color: "never"
  });
  const full = renderTeamHud(testContext, {
    preset: "full",
    maxWidth: 180,
    color: "never"
  });

  assert.match(focused, /worker-1\s+stale\s+blocked\s+role=verifier/);
  assert.match(focused, /mail=2/);
  assert.match(focused, /d=3/);
  assert.match(focused, /pane=missing/);
  assert.match(focused, /reason=waiting\?on reviewer/);
  assert.match(focused, /!/);
  assert.match(full, /task task-1 \| in_progress \| owner=worker-1\/stale \| claim_age=1h \| finish renderer/);
  for (const line of `${focused}${full}`.trimEnd().split("\n")) {
    assert.ok(visibleLength(line) <= 180, line);
  }
});

test("renderTeamHud sidecar is compact, sanitized, and action-oriented", () => {
  const rendered = renderTeamHud(context(), {
    preset: "sidecar",
    maxWidth: 82,
    maxLines: 6,
    color: "never"
  });
  const lines = rendered.trimEnd().split("\n");

  assert.ok(lines.length <= 6);
  assert.match(rendered, /AGMO sidecar/);
  assert.match(rendered, /team=demo\?team/);
  assert.match(rendered, /health workers h\/s\/d=1\/0\/0/);
  assert.match(rendered, /tmux leader=live hud=live layout=ok/);
  assert.match(rendered, /dispatch=1/);
  assert.match(rendered, /delta=0/);
  assert.match(rendered, /workers worker-1:h\/working open=1 t=task-1 d=1/);
  assert.match(rendered, /task task-1:in_progress owner=worker-1 finish renderer/);
  assert.match(rendered, /actions retry-dispatch:warning/);
  assert.doesNotMatch(rendered, /\x1b\[/);
  for (const line of lines) {
    assert.ok(visibleLength(line) <= 82, line);
  }
});

test("renderTeamHud sidecar shows compact command hints for top actions", () => {
  const testContext = context();
  testContext.suggestedActions = [
    {
      key: "alert",
      label: "Review alerts",
      reason: "1 active alert",
      severity: "info"
    },
    {
      key: "retry-dispatch",
      label: "Retry dispatch",
      reason: "pending\u0007notifications",
      severity: "warning"
    },
    {
      key: "layout-repair",
      label: "Repair layout",
      reason: "layout is repairable",
      severity: "critical"
    },
    {
      key: "task-rebalance",
      label: "Rebalance tasks",
      reason: "open task load is uneven",
      severity: "warning"
    }
  ];

  const rendered = renderTeamHud(testContext, {
    preset: "sidecar",
    maxWidth: 260,
    color: "never"
  });
  const lines = rendered.trimEnd().split("\n");

  assert.ok(lines.length <= 6);
  assert.match(rendered, /actions layout-repair:critical cmd=layout repair demo\?team --dry-run \(layout is repairable\)/);
  assert.match(rendered, /retry-dispatch:warning manual=dispatch-retry demo\?team \(pending\?notifications\)/);
  assert.match(rendered, /task-rebalance:warning manual=rebalance demo\?team \(open task load is uneven\)/);
  assert.doesNotMatch(rendered, /alert:info/);
  assert.doesNotMatch(rendered, /agmo team/);
  for (const line of lines) {
    assert.ok(visibleLength(line) <= 260, line);
  }
});

test("renderTeamHud sidecar preserves action hints within narrow width limits", () => {
  const testContext = context();
  testContext.suggestedActions = [
    {
      key: "layout-repair",
      label: "Repair layout",
      reason: "layout is repairable",
      severity: "critical"
    },
    {
      key: "retry-dispatch",
      label: "Retry dispatch",
      reason: "pending notifications",
      severity: "warning"
    }
  ];

  const rendered = renderTeamHud(testContext, {
    preset: "sidecar",
    maxWidth: 72,
    color: "never"
  });
  const lines = rendered.trimEnd().split("\n");

  assert.ok(lines.length <= 6);
  assert.match(rendered, /actions layout-repair:critical cmd=layout repair/);
  for (const line of lines) {
    assert.ok(visibleLength(line) <= 72, line);
  }
});

test("renderTeamHud sidecar summarizes topology and recent durable events", () => {
  const testContext = context();
  testContext.snapshot.active_workers = 2;
  testContext.snapshot.healthy_workers = 2;
  testContext.snapshot.workers = [
    ...testContext.snapshot.workers,
    {
      worker_name: "worker-2",
      role: "agmo-verifier",
      status_state: "idle",
      heartbeat_at: "2026-05-27T00:00:00.000Z",
      ms_since_heartbeat: 1500,
      pid_alive: true,
      heartbeat_alive_flag: true,
      turn_count: 1,
      health: "healthy",
      pending_dispatch_count: 0,
      mailbox_message_count: 0,
      pane_id: "%4",
      claim_at_risk: false,
      reasons: []
    }
  ];
  testContext.snapshot.tmux_health = {
    transport: "tmux",
    leader: "live",
    hud: "live",
    workers: {
      "worker-1": "live",
      "worker-2": "live"
    },
    layout: "ok",
    retry_pending: 0,
    retry_manual_required: 0,
    orphan_warnings: []
  };
  testContext.recentEvents = [
    {
      eventId: "evt-2",
      type: "worker_state_changed",
      sourceType: "worker_idle",
      worker: "worker-2",
      taskId: "task-2",
      state: "idle",
      createdAt: "2026-05-26T23:59:30.000Z"
    },
    {
      eventId: "evt-1",
      type: "task_completed",
      worker: "worker-1",
      taskId: "task-1",
      reason: "verified\u0007done",
      createdAt: "2026-05-26T23:59:00.000Z"
    }
  ];

  const rendered = renderTeamHud(testContext, {
    preset: "sidecar",
    maxWidth: 160,
    maxLines: 8,
    color: "never"
  });
  const lines = rendered.trimEnd().split("\n");

  assert.ok(lines.length <= 8);
  assert.match(rendered, /topology leader->worker-1\(executor\):working t=task-1/);
  assert.match(rendered, /leader->worker-2\(verifier\):idle/);
  assert.match(rendered, /events worker-2:worker_state_changed\/worker_idle state=idle t=task-2 30s ago/);
  assert.match(rendered, /worker-1:task_completed t=task-1 verified\?done 1m ago/);
  assert.match(rendered, /task task-1:in_progress owner=worker-1 finish renderer \| last worker-2:worker_state_changed\/worker_idle state=idle t=task-2/);
  assert.match(rendered, /actions retry-dispatch:warning/);
  for (const line of lines) {
    assert.ok(visibleLength(line) <= 160, line);
  }
});

test("renderTeamHud sidecar surfaces compact highlights before actions", () => {
  const testContext = context();
  testContext.snapshot.active_workers = 2;
  testContext.snapshot.healthy_workers = 1;
  testContext.snapshot.dead_workers = 1;
  testContext.snapshot.leader = {
    role: "leader",
    pane_id: "%1",
    session_id: "$1",
    health: "missing",
    reasons: ["pane_not_found"]
  };
  testContext.snapshot.workers = [
    ...testContext.snapshot.workers,
    {
      worker_name: "worker-2",
      role: "agmo-verifier",
      status_state: "blocked",
      current_task_id: "task-2",
      heartbeat_at: "2026-05-27T00:00:00.000Z",
      ms_since_heartbeat: 620000,
      pid_alive: false,
      heartbeat_alive_flag: false,
      turn_count: 0,
      health: "dead",
      pending_dispatch_count: 0,
      mailbox_message_count: 1,
      pane_id: "%4",
      claim_at_risk: true,
      reasons: ["heartbeat_timeout"]
    }
  ];
  testContext.status.tasks = [
    ...testContext.status.tasks,
    {
      id: "task-2",
      subject: "blocked review\u0007step",
      description: "",
      owner: "worker-2",
      status: "blocked",
      version: 1,
      created_at: "2026-05-27T00:00:00.000Z",
      updated_at: "2026-05-27T00:00:00.000Z"
    },
    {
      id: "task-3",
      subject: "failed task",
      description: "",
      owner: "worker-2",
      status: "failed",
      error: "verification failed",
      version: 1,
      created_at: "2026-05-27T00:00:00.000Z",
      updated_at: "2026-05-27T00:00:00.000Z"
    }
  ];
  testContext.taskCounts = { pending: 0, in_progress: 1, blocked: 1, completed: 0, failed: 1 };
  testContext.openLoads = { ...testContext.openLoads, "worker-2": 1 };

  const rendered = renderTeamHud(testContext, {
    preset: "sidecar",
    maxWidth: 160,
    maxLines: 8,
    color: "never"
  });

  assert.match(rendered, /highlights .*!! leader-pane:pane_not_found/);
  assert.match(rendered, /!! worker-2:heartbeat_timeout/);
  assert.match(rendered, /!! worker-2:task claim is at risk/);
  assert.match(rendered, /\+[0-9]+/);
  assert.match(rendered, /task task-2:blocked owner=worker-2 blocked review\?step/);
  assert.ok(rendered.indexOf("highlights") < rendered.indexOf("actions"));
  assert.doesNotMatch(rendered, /\x1b\[/);
});

test("renderTeamHud sidecar healthy baseline has no inspect hints", () => {
  const rendered = renderSidecar(context(), { maxWidth: 82, maxLines: 6 });

  assert.doesNotMatch(rendered, /\binspect=/);
  assert.doesNotMatch(rendered, /^inspect\b/m);
});

test("renderTeamHud sidecar surfaces compact worktree diagnostics and inspect hint", () => {
  const testContext = context();
  testContext.snapshot.worktree_diagnostics = {
    dirty: 1,
    manual: 1,
    cleanup: 2,
    inspect: 0,
    missing: 0
  };
  testContext.pendingDispatch = 0;
  testContext.topActions = [];

  const rendered = renderSidecar(testContext, { maxWidth: 150, maxLines: 7 });

  assert.match(rendered, /worktrees dirty=1 manual=1 cleanup=2/);
  assert.match(rendered, /worktree inspect demo\?team/);
  assertInspectHintIsReadOnly(rendered);
});

test("renderTeamHud sidecar shows read-only worker status inspect hints", () => {
  const cases: Array<{
    name: string;
    health: "healthy" | "stale" | "dead";
    status: "working" | "blocked";
    claimAtRisk: boolean;
    reason: string;
  }> = [
    {
      name: "dead",
      health: "dead",
      status: "working",
      claimAtRisk: false,
      reason: "heartbeat_timeout"
    },
    {
      name: "stale",
      health: "stale",
      status: "working",
      claimAtRisk: false,
      reason: "heartbeat_stale"
    },
    {
      name: "blocked",
      health: "healthy",
      status: "blocked",
      claimAtRisk: false,
      reason: "worker_blocked"
    },
    {
      name: "claim-risk",
      health: "healthy",
      status: "working",
      claimAtRisk: true,
      reason: "claim_at_risk"
    }
  ];

  for (const testCase of cases) {
    const testContext = context();
    testContext.snapshot.healthy_workers = testCase.health === "healthy" ? 1 : 0;
    testContext.snapshot.stale_workers = testCase.health === "stale" ? 1 : 0;
    testContext.snapshot.dead_workers = testCase.health === "dead" ? 1 : 0;
    testContext.snapshot.workers[0] = {
      ...testContext.snapshot.workers[0],
      worker_name: `worker-${testCase.name}`,
      status_state: testCase.status,
      current_task_id: `task-${testCase.name}`,
      health: testCase.health,
      ms_since_heartbeat: testCase.health === "dead" ? 620000 : 180000,
      pid_alive: testCase.health !== "dead",
      heartbeat_alive_flag: testCase.health !== "dead",
      claim_at_risk: testCase.claimAtRisk,
      reasons: [testCase.reason]
    };
    testContext.status.tasks[0] = {
      ...testContext.status.tasks[0],
      id: `task-${testCase.name}`,
      owner: `worker-${testCase.name}`,
      status: testCase.status === "blocked" ? "blocked" : "in_progress"
    };
    testContext.openLoads = { [`worker-${testCase.name}`]: 1 };
    const tmuxHealth = testContext.snapshot.tmux_health;
    assert.ok(tmuxHealth);
    testContext.snapshot.tmux_health = {
      ...tmuxHealth,
      workers: {
        [`worker-${testCase.name}`]: "live"
      }
    };

    const rendered = renderSidecar(testContext, { maxWidth: 150, maxLines: 7 });

    assert.match(rendered, /\binspect=[^\n]*status/);
    assert.match(rendered, new RegExp(`\\bworker=worker-${testCase.name}\\b`));
    assert.match(rendered, new RegExp(`\\btask=task-${testCase.name}\\b`));
    assertInspectHintIsReadOnly(rendered);
  }
});

test("renderTeamHud sidecar shows read-only task status inspect hints", () => {
  for (const status of ["blocked", "failed"] as const) {
    const testContext = context();
    testContext.status.tasks = [
      {
        id: `task-${status}`,
        subject: `${status} renderer check`,
        description: "",
        owner: "worker-1",
        status,
        error: status === "failed" ? "assertion failed" : undefined,
        version: 1,
        created_at: "2026-05-27T00:00:00.000Z",
        updated_at: "2026-05-27T00:00:00.000Z"
      }
    ];
    testContext.taskCounts = {
      pending: 0,
      in_progress: 0,
      blocked: status === "blocked" ? 1 : 0,
      completed: 0,
      failed: status === "failed" ? 1 : 0
    };

    const rendered = renderSidecar(testContext, { maxWidth: 150, maxLines: 7 });

    assert.match(rendered, /\binspect=[^\n]*status/);
    assert.match(rendered, new RegExp(`\\btask=task-${status}\\b`));
    assertInspectHintIsReadOnly(rendered);
  }
});

test("renderTeamHud sidecar shows read-only layout status inspect hints", () => {
  for (const layout of ["degraded", "repairable"] as const) {
    const testContext = context();
    testContext.snapshot.leader = {
      role: "leader",
      pane_id: "%1",
      session_id: "$1",
      health: layout === "degraded" ? "missing" : "live",
      reasons: layout === "degraded" ? ["pane_not_found"] : []
    };
    testContext.snapshot.hud = {
      role: "hud",
      pane_id: "%3",
      session_id: "$1",
      health: layout === "repairable" ? "missing" : "live",
      reasons: layout === "repairable" ? ["pane_not_found"] : []
    };
    const tmuxHealth = testContext.snapshot.tmux_health;
    assert.ok(tmuxHealth);
    testContext.snapshot.tmux_health = {
      ...tmuxHealth,
      leader: testContext.snapshot.leader.health,
      hud: testContext.snapshot.hud.health,
      layout
    };

    const rendered = renderSidecar(testContext, { maxWidth: 96, maxLines: 6 });
    const lines = rendered.trimEnd().split("\n");

    assert.ok(lines.length <= 6);
    assert.match(rendered, /\binspect=(?:layout status|layout-status)[^\n]*demo\?team/);
    assertInspectHintIsReadOnly(rendered);
    for (const line of lines) {
      assert.ok(visibleLength(line) <= 96, line);
    }
  }
});

test("renderTeamHud sidecar inspect hints respect narrow width and maxLines", () => {
  const testContext = context();
  testContext.snapshot.workers[0] = {
    ...testContext.snapshot.workers[0],
    status_state: "blocked",
    current_task_id: "task-1",
    claim_at_risk: true,
    reasons: ["waiting on reviewer with a deliberately long reason"]
  };
  testContext.status.tasks[0] = {
    ...testContext.status.tasks[0],
    status: "blocked",
    subject: "blocked renderer verification with deliberately long subject"
  };
  testContext.taskCounts = { pending: 0, in_progress: 0, blocked: 1, completed: 0, failed: 0 };

  const rendered = renderSidecar(testContext, { maxWidth: 72, maxLines: 6 });
  const lines = rendered.trimEnd().split("\n");

  assert.ok(lines.length <= 6);
  assert.match(rendered, /\binspect=[^\n]*status/);
  assert.match(rendered, /\bworker=worker-1\b/);
  assert.match(rendered, /\btask=task-1\b/);
  assertInspectHintIsReadOnly(rendered);
  for (const line of lines) {
    assert.ok(visibleLength(line) <= 72, line);
  }
});

test("renderTeamHud sorts structured actions and limits focused commands to safe actions", () => {
  const testContext = context();
  testContext.suggestedActions = [
    {
      key: "alert",
      label: "Review alerts",
      reason: "1 active alert",
      severity: "info"
    },
    {
      key: "reclaim",
      label: "Reclaim claims",
      reason: "claim is at risk",
      severity: "critical"
    },
    {
      key: "layout-repair",
      label: "Repair layout",
      reason: "layout is repairable",
      severity: "critical"
    },
    {
      key: "nudge",
      label: "Nudge workers",
      reason: "worker is stale",
      severity: "warning",
      command: "agmo team monitor demo --auto-nudge",
      mutating: false
    }
  ];

  const focused = renderTeamHud(testContext, {
    preset: "focused",
    maxWidth: 160,
    color: "never"
  });

  assert.match(focused, /Actions/);
  assert.match(focused, /layout-repair \[critical\].*cmd: agmo team layout repair demo\?team --dry-run/);
  assert.match(focused, /reclaim \[critical\]/);
  assert.match(focused, /nudge \[warning\]/);
  assert.doesNotMatch(focused, /alert \[info\]/);
  assert.doesNotMatch(focused, /manual:/);
  assert.doesNotMatch(focused, /--auto-nudge/);
  assert.doesNotMatch(focused, /--reassign/);
  assert.ok(focused.indexOf("layout-repair") < focused.indexOf("reclaim"));
});

test("renderTeamHud maps legacy rebalance to task-rebalance and gates mutating commands to full", () => {
  const testContext = context();
  testContext.topActions = ["rebalance", "retry-dispatch"];

  const minimal = renderTeamHud(testContext, {
    preset: "minimal",
    maxWidth: 100,
    color: "never"
  });
  assert.match(minimal, /actions=retry-dispatch,task-rebalance/);
  assert.doesNotMatch(minimal, /Actions/);

  const full = renderTeamHud(testContext, {
    preset: "full",
    maxWidth: 160,
    color: "never"
  });
  assert.match(full, /retry-dispatch \[warning\].*manual: agmo team dispatch-retry demo\?team/);
  assert.match(full, /task-rebalance \[warning\].*manual: agmo team rebalance demo\?team/);
  assert.doesNotMatch(full, /layout rebalance/);
});

test("renderTeamHud shows compact legend only when requested", () => {
  const withoutLegend = renderTeamHud(context(), {
    preset: "focused",
    maxWidth: 140,
    color: "never"
  });
  assert.doesNotMatch(withoutLegend, /Legend:/);

  const withLegend = renderTeamHud(context(), {
    preset: "focused",
    maxWidth: 140,
    color: "never",
    showLegend: true
  });
  assert.match(withLegend, /Legend: h=healthy s=stale d=dead/);

  const minimalLegend = renderTeamHud(context(), {
    preset: "minimal",
    maxWidth: 140,
    color: "never",
    showLegend: true
  });
  assert.match(minimalLegend, /Legend: h=healthy s=stale d=dead/);
});

test("renderTeamHud can force color", () => {
  const rendered = renderTeamHud(context(), { color: "always" });
  assert.match(rendered, /\x1b\[/);
});
