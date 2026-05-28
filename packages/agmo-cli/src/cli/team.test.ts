import assert from "node:assert/strict";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { shutdownTeamRuntime, startTeamRuntime } from "../team/runtime.js";
import { runTeamCommand } from "./team.js";

async function captureTeamCommand(
  args: string[],
  cwd: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(await captureTeamCommandText(args, cwd)) as Record<string, unknown>;
}

async function captureTeamCommandText(
  args: string[],
  cwd: string,
): Promise<string> {
  const originalCwd = process.cwd();
  const originalProjectRoot = process.env.AGMO_PROJECT_ROOT;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const stdoutChunks: string[] = [];

  process.env.AGMO_PROJECT_ROOT = cwd;
  process.chdir(cwd);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"),
    );
    return true;
  }) as typeof process.stdout.write;

  try {
    await runTeamCommand(args);
  } finally {
    process.stdout.write = originalWrite;
    process.chdir(originalCwd);
    if (originalProjectRoot === undefined) {
      delete process.env.AGMO_PROJECT_ROOT;
    } else {
      process.env.AGMO_PROJECT_ROOT = originalProjectRoot;
    }
  }

  return stdoutChunks.join("");
}

test("runTeamCommand status prints current ad hoc JSON shape for an existing team", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-status-"));
  const teamName = "cli-status-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Characterize team status JSON",
      mode: "interactive",
    },
    tempRoot,
  );

  const output = await captureTeamCommand(["status", teamName], tempRoot);

  assert.equal(output.command, "team status");
  assert.equal(output.team_name, teamName);
  assert.equal(output.found, true);
  assert.ok("tmux_health" in output);
  assert.ok(output.status && typeof output.status === "object");
  const status = output.status as Record<string, unknown>;
  assert.deepEqual(Object.keys(status).sort(), [
    "config",
    "dispatch_requests",
    "hud_repair",
    "integrations",
    "leader_alert_delivery",
    "leader_escalations",
    "leader_nudges",
    "mailbox",
    "manifest",
    "pane_close_retry",
    "phase",
    "shutdown",
    "tasks",
    "workers",
  ]);
  assert.equal((status.config as { name?: string }).name, teamName);
  assert.equal((status.phase as { current_phase?: string }).current_phase, "active");
  assert.equal(Array.isArray(status.tasks), true);
  assert.equal(Array.isArray(status.workers), true);
});

test("runTeamCommand shutdown-ack prints current ad hoc JSON shape after shutdown request", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-shutdown-ack-"));
  const teamName = "cli-shutdown-ack-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Characterize team shutdown ack JSON",
      mode: "interactive",
    },
    tempRoot,
  );
  await shutdownTeamRuntime(teamName, { graceMs: 0 }, tempRoot);

  const output = await captureTeamCommand(
    [
      "shutdown-ack",
      teamName,
      "worker-1",
      "accepted",
      "--reason",
      "characterization ack",
      "--task",
      "1",
    ],
    tempRoot,
  );

  assert.equal(output.command, "team shutdown-ack");
  assert.equal(output.team_name, teamName);
  assert.equal(output.worker_name, "worker-1");
  assert.ok(output.acknowledgement && typeof output.acknowledgement === "object");
  assert.deepEqual(output.acknowledgement, {
    worker_name: "worker-1",
    pane_id: null,
    status: "accepted",
    source: "explicit",
    reason: "characterization ack",
    task_id: "1",
    acked_at: (output.acknowledgement as { acked_at: string }).acked_at,
  });
  assert.match(
    (output.acknowledgement as { acked_at: string }).acked_at,
    /^\d{4}-\d{2}-\d{2}T/,
  );
  assert.deepEqual(output.aggregate, {
    accepted: 1,
    busy: 0,
    rejected: 0,
    total: 1,
  });
});

test("runTeamCommand hud supports preset width max-lines and no-color flags", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-hud-flags-"));
  const teamName = "cli-hud-flags-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Render HUD with CLI flags",
      mode: "interactive",
    },
    tempRoot,
  );

  const output = await captureTeamCommandText(
    [
      "hud",
      teamName,
      "--preset",
      "minimal",
      "--width",
      "40",
      "--max-lines",
      "3",
      "--no-color",
    ],
    tempRoot,
  );

  assert.match(output, /AGMO HUD/);
  assert.doesNotMatch(output, /\x1b\[/);
  assert.ok(!output.includes("Workers"));
  for (const line of output.trimEnd().split("\n")) {
    assert.ok(line.length <= 40, line);
  }
});

test("runTeamCommand hud width rejects non-integer values", async () => {
  await assert.rejects(
    () => runTeamCommand(["hud", "demo", "--width", "80px"]),
    /--width must be an integer/,
  );
  await assert.rejects(
    () => runTeamCommand(["hud", "demo", "--width", "auto"]),
    /--width must be an integer/,
  );
});

test("runTeamCommand hud supports legend flag without enabling it by default", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-hud-legend-"));
  const teamName = "cli-hud-legend-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Render HUD legend with CLI flag",
      mode: "interactive",
    },
    tempRoot,
  );

  const defaultOutput = await captureTeamCommandText(
    ["hud", teamName, "--preset", "focused", "--width", "120", "--no-color"],
    tempRoot,
  );
  const legendOutput = await captureTeamCommandText(
    ["hud", teamName, "--preset", "focused", "--width", "120", "--legend", "--no-color"],
    tempRoot,
  );

  assert.doesNotMatch(defaultOutput, /Legend:/);
  assert.match(legendOutput, /Legend: h=healthy s=stale d=dead/);
});

test("runTeamCommand hud watch includes refresh footer", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-hud-watch-"));
  const teamName = "cli-hud-watch-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Render HUD watch footer",
      mode: "interactive",
    },
    tempRoot,
  );

  const output = await captureTeamCommandText(
    [
      "hud",
      teamName,
      "--watch",
      "--iterations",
      "1",
      "--no-clear",
      "--refresh-ms",
      "250",
      "--width",
      "80",
      "--no-color",
    ],
    tempRoot,
  );

  assert.match(output, /watch refresh=250ms checked=/);
  for (const line of output.trimEnd().split("\n")) {
    assert.ok(line.length <= 80, line);
  }
});

test("runTeamCommand layout commands print stable JSON contracts for non-tmux teams", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-layout-"));
  const teamName = "cli-layout-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Characterize team layout JSON",
      mode: "interactive",
    },
    tempRoot,
  );

  const status = await captureTeamCommand(["layout", "status", teamName], tempRoot);
  assert.equal(status.command, "team layout status");
  assert.equal(status.team_name, teamName);
  assert.equal(status.transport, "none");
  assert.equal(status.dry_run, false);
  assert.equal(status.layout_health, "skipped");
  assert.ok(status.panes && typeof status.panes === "object");
  assert.deepEqual(status.recommended_actions, []);

  const repair = await captureTeamCommand(
    ["layout", "repair", teamName, "--dry-run"],
    tempRoot,
  );
  assert.equal(repair.command, "team layout repair");
  assert.equal(repair.team_name, teamName);
  assert.equal(repair.dry_run, true);
  assert.equal(repair.status, "skipped");
  assert.deepEqual(repair.performed, []);
  assert.deepEqual(repair.failed, []);
  assert.deepEqual(repair.refused, []);

  const rebalance = await captureTeamCommand(
    ["layout", "rebalance", teamName, "--layout", "auto", "--dry-run"],
    tempRoot,
  );
  assert.equal(rebalance.command, "team layout rebalance");
  assert.equal(rebalance.team_name, teamName);
  assert.equal(rebalance.dry_run, true);
  assert.equal(rebalance.status, "skipped");
  assert.deepEqual(rebalance.performed, []);
  assert.deepEqual(rebalance.failed, []);
  assert.deepEqual(rebalance.refused, []);
});
