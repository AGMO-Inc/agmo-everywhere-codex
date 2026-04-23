import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cleanupStaleTeamRuntimes,
  readTeamStatus,
  shutdownTeamRuntime,
  shouldSpawnTeamTmuxPanes,
  startTeamRuntime
} from "./runtime.js";
import {
  resolveTeamDispatchPath,
  resolveTeamTaskPath,
  resolveWorkerHeartbeatPath,
  resolveWorkerStatusPath
} from "./state/index.js";

test("shutdownTeamRuntime clears active worker, task, and dispatch state", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-shutdown-"));
  const teamName = "shutdown-cleanup";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 2,
      task: "Implement shutdown cleanup",
      mode: "interactive"
    },
    tempRoot
  );

  const activeAt = "2026-04-23T12:00:00.000Z";

  await writeFile(
    resolveTeamTaskPath(teamName, "1", tempRoot),
    `${JSON.stringify(
      {
        id: "1",
        subject: "lane 1",
        description: "primary implementation lane",
        owner: "worker-1",
        role: "agmo-executor",
        status: "in_progress",
        requires_code_change: true,
        claim: {
          owner: "worker-1",
          claimed_at: activeAt
        },
        version: 2,
        created_at: activeAt,
        updated_at: activeAt
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    resolveTeamTaskPath(teamName, "2", tempRoot),
    `${JSON.stringify(
      {
        id: "2",
        subject: "lane 2",
        description: "secondary verification lane",
        owner: "worker-2",
        role: "agmo-verifier",
        status: "pending",
        requires_code_change: false,
        version: 1,
        created_at: activeAt,
        updated_at: activeAt
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    resolveWorkerStatusPath(teamName, "worker-1", tempRoot),
    `${JSON.stringify(
      {
        state: "working",
        current_task_id: "1",
        updated_at: activeAt
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    resolveWorkerHeartbeatPath(teamName, "worker-1", tempRoot),
    `${JSON.stringify(
      {
        alive: true,
        pid: 43210,
        turn_count: 8,
        last_turn_at: activeAt
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    resolveTeamDispatchPath(teamName, tempRoot),
    `${JSON.stringify(
      [
        {
          request_id: "req-1",
          kind: "inbox",
          to_worker: "worker-1",
          status: "pending",
          created_at: activeAt,
          transport_preference: "hook_preferred_with_fallback"
        }
      ],
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = await shutdownTeamRuntime(teamName, tempRoot);
  assert.equal(result.team_name, teamName);
  assert.equal(result.current_phase, "shutdown");
  assert.equal(result.tasks_failed, 2);
  assert.equal(result.dispatch_requests_failed, 1);

  const status = await readTeamStatus(teamName, tempRoot);
  assert.ok(status);
  assert.equal(status.config.active, false);
  assert.equal(status.config.phase, "shutdown");
  assert.equal(status.phase.active, false);
  assert.equal(status.phase.current_phase, "shutdown");

  const taskOne = status.tasks.find((task) => task.id === "1");
  const taskTwo = status.tasks.find((task) => task.id === "2");
  assert.ok(taskOne);
  assert.ok(taskTwo);
  assert.equal(taskOne.status, "failed");
  assert.match(taskOne.error ?? "", /shut down before task completion/i);
  assert.equal(taskOne.claim, undefined);
  assert.equal(
    taskOne.claim_history?.[taskOne.claim_history.length - 1]?.release_reason,
    "team_shutdown"
  );
  assert.equal(taskTwo.status, "failed");

  const workerOne = status.workers.find((worker) => worker.identity.name === "worker-1");
  assert.ok(workerOne);
  assert.equal(workerOne.status.state, "idle");
  assert.equal(workerOne.status.current_task_id, undefined);
  assert.equal(workerOne.heartbeat.alive, false);
  assert.equal(workerOne.heartbeat.pid, undefined);
  assert.equal(workerOne.heartbeat.turn_count, 8);

  assert.equal(status.dispatch_requests[0]?.status, "failed");
  assert.ok(status.dispatch_requests[0]?.failed_at);

  const events = await readFile(join(tempRoot, ".agmo", "state", "team", teamName, "events.ndjson"), "utf8");
  assert.match(events, /"type":"team_shutdown"/);
});

test("startTeamRuntime persists session ownership metadata when provided", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-session-"));
  const teamName = "session-owned-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Track current session ownership",
      mode: "interactive",
      sessionId: "session-owned-123"
    },
    tempRoot
  );

  const status = await readTeamStatus(teamName, tempRoot);
  assert.ok(status);
  assert.equal(status.config.session_id, "session-owned-123");
  assert.equal(status.config.transport, "none");
  assert.deepEqual(status.config.tmux.worker_pane_ids, {});
});

test("shouldSpawnTeamTmuxPanes requires explicit live team runtime intent", () => {
  assert.equal(
    shouldSpawnTeamTmuxPanes(
      {
        spawnTmuxPanes: true,
        tmuxSpawnIntent: "live-team-runtime"
      },
      {
        available: true,
        in_tmux_client: true
      }
    ),
    true
  );

  assert.equal(
    shouldSpawnTeamTmuxPanes(
      {
        spawnTmuxPanes: true
      },
      {
        available: true,
        in_tmux_client: true
      }
    ),
    false
  );
});

test("cleanupStaleTeamRuntimes bulk-shuts stale active teams when includeStale is enabled", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cleanup-"));
  const staleTeam = "cleanup-stale-team";
  const healthyTeam = "cleanup-healthy-team";
  const staleAt = "2026-04-20T12:00:00.000Z";

  await startTeamRuntime(
    {
      teamName: staleTeam,
      workerCount: 1,
      task: "Stale team",
      mode: "interactive",
      sessionId: "cleanup-session-123"
    },
    tempRoot
  );
  await startTeamRuntime(
    {
      teamName: healthyTeam,
      workerCount: 1,
      task: "Healthy team",
      mode: "interactive"
    },
    tempRoot
  );

  await writeFile(
    resolveWorkerStatusPath(staleTeam, "worker-1", tempRoot),
    `${JSON.stringify(
      {
        state: "working",
        current_task_id: "1",
        updated_at: staleAt
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    resolveWorkerHeartbeatPath(staleTeam, "worker-1", tempRoot),
    `${JSON.stringify(
      {
        alive: true,
        turn_count: 3,
        last_turn_at: staleAt
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const dryRun = await cleanupStaleTeamRuntimes(
    {
      staleAfterMs: 60_000,
      deadAfterMs: Number.MAX_SAFE_INTEGER,
      includeStale: true,
      dryRun: true
    },
    tempRoot
  );
  assert.equal(dryRun.cleaned.length, 1);
  assert.equal(dryRun.cleaned[0]?.team_name, staleTeam);
  assert.equal(dryRun.cleaned[0]?.dry_run, true);

  const result = await cleanupStaleTeamRuntimes(
    {
      staleAfterMs: 60_000,
      deadAfterMs: Number.MAX_SAFE_INTEGER,
      includeStale: true
    },
    tempRoot
  );
  assert.equal(result.cleaned.length, 1);
  assert.equal(result.cleaned[0]?.team_name, staleTeam);
  assert.equal(result.cleaned[0]?.reason, "no_healthy_workers");
  assert.equal(result.cleaned[0]?.shutdown?.current_phase, "shutdown");

  const staleStatus = await readTeamStatus(staleTeam, tempRoot);
  const healthyStatus = await readTeamStatus(healthyTeam, tempRoot);
  assert.ok(staleStatus);
  assert.ok(healthyStatus);
  assert.equal(staleStatus.config.active, false);
  assert.equal(staleStatus.phase.active, false);
  assert.equal(staleStatus.config.session_id, "cleanup-session-123");
  assert.equal(healthyStatus.config.active, true);
  assert.equal(healthyStatus.phase.active, true);
});

test("cleanupStaleTeamRuntimes keeps stale-only teams by default and cleans dead teams", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cleanup-defaults-"));
  const deadTeam = "cleanup-dead-team";
  const staleTeam = "cleanup-stale-only-team";
  const healthyTeam = "cleanup-defaults-healthy-team";
  const deadAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const staleAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();

  await startTeamRuntime(
    {
      teamName: deadTeam,
      workerCount: 1,
      task: "Dead team",
      mode: "interactive"
    },
    tempRoot
  );
  await startTeamRuntime(
    {
      teamName: staleTeam,
      workerCount: 1,
      task: "Stale-only team",
      mode: "interactive"
    },
    tempRoot
  );
  await startTeamRuntime(
    {
      teamName: healthyTeam,
      workerCount: 1,
      task: "Healthy team",
      mode: "interactive"
    },
    tempRoot
  );

  await writeFile(
    resolveWorkerStatusPath(deadTeam, "worker-1", tempRoot),
    `${JSON.stringify(
      {
        state: "working",
        current_task_id: "1",
        updated_at: deadAt
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    resolveWorkerHeartbeatPath(deadTeam, "worker-1", tempRoot),
    `${JSON.stringify(
      {
        alive: true,
        pid: 999999,
        turn_count: 1,
        last_turn_at: deadAt
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await writeFile(
    resolveWorkerStatusPath(staleTeam, "worker-1", tempRoot),
    `${JSON.stringify(
      {
        state: "working",
        current_task_id: "1",
        updated_at: staleAt
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    resolveWorkerHeartbeatPath(staleTeam, "worker-1", tempRoot),
    `${JSON.stringify(
      {
        alive: true,
        pid: process.pid,
        turn_count: 2,
        last_turn_at: staleAt
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = await cleanupStaleTeamRuntimes(
    {
      staleAfterMs: 60_000,
      deadAfterMs: 5 * 60_000
    },
    tempRoot
  );

  assert.equal(result.cleaned.length, 1);
  assert.equal(result.cleaned[0]?.team_name, deadTeam);
  assert.equal(result.cleaned[0]?.reason, "all_workers_dead");

  const deadStatus = await readTeamStatus(deadTeam, tempRoot);
  const staleStatus = await readTeamStatus(staleTeam, tempRoot);
  const healthyStatus = await readTeamStatus(healthyTeam, tempRoot);
  assert.ok(deadStatus);
  assert.ok(staleStatus);
  assert.ok(healthyStatus);
  assert.equal(deadStatus.config.active, false);
  assert.equal(staleStatus.config.active, true);
  assert.equal(staleStatus.phase.active, true);
  assert.equal(healthyStatus.config.active, true);
  assert.equal(healthyStatus.phase.active, true);
});
