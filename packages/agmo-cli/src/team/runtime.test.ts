import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acknowledgeShutdownRequest,
  claimTaskForWorker,
  cleanupStaleTeamRuntimes,
  completeTaskForWorker,
  heartbeatWorker,
  monitorTeamRuntime,
  readTeamStatus,
  readTeamTmuxHealthSummary,
  recordWorkerHookActivity,
  repairTeamHudPane,
  reportWorkerStatus,
  runCodexFreeTeamLifecycleSmoke,
  shutdownTeamRuntime,
  shouldSpawnTeamTmuxPanes,
  startTeamRuntime
} from "./runtime.js";
import {
  resolveTeamConfigPath,
  resolveTeamDispatchPath,
  resolveTeamHudRepairPath,
  resolveTeamPaneCloseRetryPath,
  resolveTeamTaskPath,
  resolveWorkerHeartbeatPath,
  resolveWorkerStatusPath
} from "./state/index.js";
import {
  acquireTeamStateLock,
  resolveTeamStateLockPath
} from "./state/locks.js";

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
  assert.equal((result.shutdown_request as { requested?: boolean }).requested, true);

  const status = await readTeamStatus(teamName, tempRoot);
  assert.ok(status);
  assert.equal(status.shutdown?.requested, true);
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

test("concurrent task claims serialize so only one worker owns an unassigned task", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-concurrent-claim-"));
  const teamName = "concurrent-claim-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 2,
      task: "Claim the same unassigned task",
      mode: "interactive"
    },
    tempRoot
  );

  const taskPath = resolveTeamTaskPath(teamName, "1", tempRoot);
  const task = JSON.parse(await readFile(taskPath, "utf8")) as Record<string, unknown>;
  delete task.owner;
  await writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf8");

  const results = await Promise.allSettled([
    claimTaskForWorker(teamName, "1", "worker-1", {}, tempRoot),
    claimTaskForWorker(teamName, "1", "worker-2", {}, tempRoot)
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(
    rejected[0]?.reason instanceof Error ? rejected[0].reason.message : String(rejected[0]?.reason),
    /owned by worker-[12]/
  );

  const finalTask = JSON.parse(await readFile(taskPath, "utf8")) as {
    owner?: string;
    status?: string;
    claim?: { owner?: string };
  };
  assert.equal(finalTask.status, "in_progress");
  assert.equal(finalTask.owner, finalTask.claim?.owner);
  assert.ok(["worker-1", "worker-2"].includes(finalTask.owner ?? ""));
});

test("stale team-state lock is recovered and task mutation proceeds", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-stale-lock-"));
  const teamName = "stale-lock-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Recover stale lock",
      mode: "interactive"
    },
    tempRoot
  );

  const lockPath = resolveTeamStateLockPath(teamName, "team-state", tempRoot);
  await mkdir(lockPath, { recursive: true });
  await writeFile(
    join(lockPath, "metadata.json"),
    `${JSON.stringify(
      {
        lock_name: "team-state",
        owner_id: "stale-owner",
        operation: "abandoned operation",
        acquired_at: "2026-04-23T12:00:00.000Z",
        expires_at: "2026-04-23T12:00:00.001Z",
        stale_after_ms: 1,
        pid: 999999
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = await claimTaskForWorker(teamName, "1", "worker-1", {}, tempRoot);
  assert.equal((result.task as { status?: string }).status, "in_progress");

  const task = JSON.parse(
    await readFile(resolveTeamTaskPath(teamName, "1", tempRoot), "utf8")
  ) as { claim?: { owner?: string } };
  assert.equal(task.claim?.owner, "worker-1");
});

test("malformed team-state lock is recovered and task mutation proceeds", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-malformed-lock-"));
  const teamName = "malformed-lock-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Recover malformed lock",
      mode: "interactive"
    },
    tempRoot
  );

  const lockPath = resolveTeamStateLockPath(teamName, "team-state", tempRoot);
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, "metadata.json"), "{not-json", "utf8");

  const result = await claimTaskForWorker(teamName, "1", "worker-1", {}, tempRoot);
  assert.equal((result.task as { status?: string }).status, "in_progress");

  const task = JSON.parse(
    await readFile(resolveTeamTaskPath(teamName, "1", tempRoot), "utf8")
  ) as { claim?: { owner?: string } };
  assert.equal(task.claim?.owner, "worker-1");
});

test("lock takeover metadata records stale and malformed recovery signals", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-lock-metadata-"));
  const teamName = "lock-metadata-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Expose lock metadata",
      mode: "interactive"
    },
    tempRoot
  );

  const staleLockPath = resolveTeamStateLockPath(teamName, "team-state", tempRoot);
  await mkdir(staleLockPath, { recursive: true });
  await writeFile(
    join(staleLockPath, "metadata.json"),
    `${JSON.stringify(
      {
        lock_name: "team-state",
        owner_id: "stale-owner",
        operation: "stale operation",
        acquired_at: "2026-04-23T12:00:00.000Z",
        expires_at: "2026-04-23T12:00:00.001Z",
        stale_after_ms: 1
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const staleRecovered = await acquireTeamStateLock(
    teamName,
    "team-state",
    "metadata stale recovery",
    tempRoot
  );
  const staleMetadata = JSON.parse(
    await readFile(staleRecovered.metadataPath, "utf8")
  ) as { recovered_from?: { reason?: string; metadata?: { owner_id?: string } } };
  assert.equal(staleMetadata.recovered_from?.reason, "stale");
  assert.equal(staleMetadata.recovered_from?.metadata?.owner_id, "stale-owner");
  await staleRecovered.release();

  const malformedLockPath = resolveTeamStateLockPath(teamName, "team-state", tempRoot);
  await mkdir(malformedLockPath, { recursive: true });
  await writeFile(join(malformedLockPath, "metadata.json"), "[]", "utf8");

  const malformedRecovered = await acquireTeamStateLock(
    teamName,
    "team-state",
    "metadata malformed recovery",
    tempRoot
  );
  const malformedMetadata = JSON.parse(
    await readFile(malformedRecovered.metadataPath, "utf8")
  ) as { recovered_from?: { reason?: string; error?: string } };
  assert.equal(malformedMetadata.recovered_from?.reason, "malformed");
  assert.match(malformedMetadata.recovered_from?.error ?? "", /required fields/);
  await malformedRecovered.release();
});

test("recent malformed team-state lock is treated as initializing", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-initializing-lock-"));
  const teamName = "initializing-lock-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Wait for initializing lock",
      mode: "interactive"
    },
    tempRoot
  );

  const lockPath = resolveTeamStateLockPath(teamName, "team-state", tempRoot);
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, "metadata.json"), "{not-json", "utf8");

  await assert.rejects(
    acquireTeamStateLock(
      teamName,
      "team-state",
      "wait for initializing metadata",
      tempRoot,
      { timeoutMs: 5, retryMs: 1 }
    ),
    /holder=initializing/
  );

  assert.equal(await readFile(join(lockPath, "metadata.json"), "utf8"), "{not-json");
});

test("completeTaskForWorker shuts down the team after the last task completes", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-complete-shutdown-"));
  const teamName = "complete-shutdown-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Complete the only task",
      mode: "interactive"
    },
    tempRoot
  );

  const configPath = resolveTeamConfigPath(teamName, tempRoot);
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    transport: string;
    tmux: {
      worker_pane_ids: Record<string, string>;
      hud_pane_id?: string | null;
    };
  };
  config.transport = "tmux";
  config.tmux.worker_pane_ids = {
    "worker-1": "not-a-pane"
  };
  config.tmux.hud_pane_id = "also-not-a-pane";
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  await claimTaskForWorker(teamName, "1", "worker-1", {}, tempRoot);
  const result = await completeTaskForWorker(
    teamName,
    "1",
    "worker-1",
    "completed result",
    tempRoot
  );

  assert.equal(result.team_name, teamName);
  assert.equal((result.task as { status: string; result?: string }).status, "completed");
  assert.equal((result.task as { result?: string }).result, "completed result");
  const autoShutdown = result.auto_shutdown as {
    triggered?: boolean;
    reason?: string;
    shutdown?: {
      current_phase?: string;
      tmux_pane_destruction?: { skipped: number };
    };
  };
  assert.equal(autoShutdown.triggered, true);
  assert.equal(autoShutdown.reason, "all_tasks_completed");
  assert.equal(autoShutdown.shutdown?.current_phase, "shutdown");
  assert.equal(autoShutdown.shutdown?.tmux_pane_destruction?.skipped, 2);

  const status = await readTeamStatus(teamName, tempRoot);
  assert.ok(status);
  assert.equal(status.config.active, false);
  assert.equal(status.config.phase, "shutdown");
  assert.equal(status.phase.current_phase, "shutdown");
  assert.equal(status.tasks[0]?.status, "completed");
  assert.equal(status.tasks[0]?.result, "completed result");

  const events = await readFile(join(tempRoot, ".agmo", "state", "team", teamName, "events.ndjson"), "utf8");
  assert.match(events, /"type":"task_completed"/);
  assert.match(events, /"type":"team_shutdown"/);
  assert.match(events, /"tmux_pane_destruction"/);
});

test("shutdownTeamRuntime records pane-close retries when guarded tmux panes remain", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-pane-retry-"));
  const teamName = "pane-retry-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Retry guarded pane closes",
      mode: "interactive"
    },
    tempRoot
  );

  const configPath = resolveTeamConfigPath(teamName, tempRoot);
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    transport: string;
    tmux: {
      session_id?: string | null;
      worker_pane_ids: Record<string, string>;
      hud_pane_id?: string | null;
    };
  };
  config.transport = "tmux";
  config.tmux.session_id = "$missing-session";
  config.tmux.worker_pane_ids = {
    "worker-1": "%998"
  };
  config.tmux.hud_pane_id = "%999";
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const result = await shutdownTeamRuntime(teamName, { graceMs: 0 }, tempRoot);
  const destruction = result.tmux_pane_destruction as { skipped: number; killed: number };
  assert.equal(destruction.killed, 0);
  assert.equal(destruction.skipped, 2);

  const retryState = JSON.parse(
    await readFile(resolveTeamPaneCloseRetryPath(teamName, tempRoot), "utf8")
  ) as {
    entries: Array<{
      pane_id: string;
      attempts: number;
      status?: string;
      cleared_at?: string;
      last_error?: string;
    }>;
  };
  assert.deepEqual(
    retryState.entries.map((entry) => entry.pane_id).sort(),
    ["%998", "%999"]
  );
  assert.equal(retryState.entries[0]?.attempts, 1);
  assert.equal(retryState.entries[0]?.status, "cleared");
  assert.ok(retryState.entries[0]?.cleared_at);
  assert.match(retryState.entries[0]?.last_error ?? "", /not found/);
});

test("cleanupStaleTeamRuntimes moves exhausted protected pane retries to manual_required", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-pane-manual-"));
  const teamName = "pane-manual-team";
  const timestamp = "2026-04-23T12:00:00.000Z";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Mark protected retry manual",
      mode: "interactive"
    },
    tempRoot
  );
  await writeFile(
    resolveTeamPaneCloseRetryPath(teamName, tempRoot),
    `${JSON.stringify(
      {
        updated_at: timestamp,
        entries: [
          {
            pane_id: "%protected",
            team_name: teamName,
            role: "worker",
            worker_name: "worker-1",
            session_id: null,
            leader_pane_id: "%protected",
            status: "pending",
            max_attempts: 3,
            attempts: 2,
            first_seen_at: timestamp,
            next_attempt_at: timestamp
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const cleanup = await cleanupStaleTeamRuntimes(
    {
      retryPaneCloses: true
    },
    tempRoot
  );
  assert.equal(cleanup.tmux_sweep.retry_queues[0]?.pending, 0);

  const retryState = JSON.parse(
    await readFile(resolveTeamPaneCloseRetryPath(teamName, tempRoot), "utf8")
  ) as { entries: Array<{ status?: string; attempts: number; last_error?: string }> };
  assert.equal(retryState.entries[0]?.status, "manual_required");
  assert.equal(retryState.entries[0]?.attempts, 3);
  assert.match(retryState.entries[0]?.last_error ?? "", /protected/);
});

test("completeTaskForWorker keeps the team active while other tasks remain incomplete", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-complete-partial-"));
  const teamName = "complete-partial-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 2,
      task: "Complete one of two tasks",
      mode: "interactive"
    },
    tempRoot
  );

  await claimTaskForWorker(teamName, "1", "worker-1", {}, tempRoot);
  const result = await completeTaskForWorker(
    teamName,
    "1",
    "worker-1",
    "worker one done",
    tempRoot
  );
  const autoShutdown = result.auto_shutdown as { triggered?: boolean; reason?: string };
  assert.equal(autoShutdown.triggered, false);
  assert.equal(autoShutdown.reason, "tasks_not_all_completed");

  const status = await readTeamStatus(teamName, tempRoot);
  assert.ok(status);
  assert.equal(status.config.active, true);
  assert.equal(status.phase.active, true);
  assert.equal(status.tasks.find((task) => task.id === "1")?.status, "completed");
  assert.notEqual(status.tasks.find((task) => task.id === "2")?.status, "completed");
});

test("completeTaskForWorker does not auto-shutdown when another task failed", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-complete-failed-peer-"));
  const teamName = "complete-failed-peer-team";
  const failedAt = "2026-04-23T12:30:00.000Z";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 2,
      task: "Complete with failed peer task",
      mode: "interactive"
    },
    tempRoot
  );

  await writeFile(
    resolveTeamTaskPath(teamName, "2", tempRoot),
    `${JSON.stringify(
      {
        id: "2",
        subject: "failed peer lane",
        description: "peer task already failed",
        owner: "worker-2",
        role: "agmo-verifier",
        status: "failed",
        requires_code_change: false,
        error: "verification failed",
        version: 2,
        created_at: failedAt,
        updated_at: failedAt
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await claimTaskForWorker(teamName, "1", "worker-1", {}, tempRoot);
  const result = await completeTaskForWorker(
    teamName,
    "1",
    "worker-1",
    "worker one done",
    tempRoot
  );

  const autoShutdown = result.auto_shutdown as { triggered?: boolean; reason?: string };
  assert.equal(autoShutdown.triggered, false);
  assert.equal(autoShutdown.reason, "tasks_not_all_completed");

  const status = await readTeamStatus(teamName, tempRoot);
  assert.ok(status);
  assert.equal(status.config.active, true);
  assert.equal(status.phase.active, true);
  assert.equal(status.tasks.find((task) => task.id === "1")?.status, "completed");
  assert.equal(status.tasks.find((task) => task.id === "2")?.status, "failed");
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

test("monitor and cleanup detect orphaned leader tmux panes", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-leader-orphan-"));
  const teamName = "leader-orphan-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Detect leader orphan",
      mode: "interactive"
    },
    tempRoot
  );

  const configPath = resolveTeamConfigPath(teamName, tempRoot);
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    transport: string;
    tmux: {
      session_id?: string | null;
      leader_pane_id: string | null;
      worker_pane_ids: Record<string, string>;
    };
  };
  config.transport = "tmux";
  config.tmux.session_id = "$missing-session";
  config.tmux.leader_pane_id = "%997";
  config.tmux.worker_pane_ids = {};
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const snapshot = await monitorTeamRuntime(
    teamName,
    {
      staleAfterMs: Number.MAX_SAFE_INTEGER,
      deadAfterMs: Number.MAX_SAFE_INTEGER
    },
    tempRoot
  );
  assert.equal(snapshot.leader?.health, "missing");
  assert.deepEqual(snapshot.leader?.reasons, ["pane_not_found"]);
  assert.equal(snapshot.layout_health, "degraded");
  assert.equal(snapshot.tmux_health?.layout, "degraded");

  const cleanup = await cleanupStaleTeamRuntimes(
    {
      staleAfterMs: Number.MAX_SAFE_INTEGER,
      deadAfterMs: Number.MAX_SAFE_INTEGER,
      dryRun: true
    },
    tempRoot
  );
  assert.equal(cleanup.cleaned.length, 1);
  assert.equal(cleanup.cleaned[0]?.team_name, teamName);
  assert.equal(cleanup.cleaned[0]?.reason, "leader_orphaned");
  assert.equal(cleanup.cleaned[0]?.leader_health, "missing");
});

test("readTeamTmuxHealthSummary reports orphan and retry counts for status surfaces", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-tmux-health-"));
  const teamName = "tmux-health-team";
  const timestamp = "2026-04-23T12:00:00.000Z";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Summarize tmux health",
      mode: "interactive"
    },
    tempRoot
  );
  const configPath = resolveTeamConfigPath(teamName, tempRoot);
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    transport: string;
    tmux: {
      session_id?: string | null;
      leader_pane_id: string | null;
      hud_pane_id?: string | null;
      worker_pane_ids: Record<string, string>;
    };
  };
  config.transport = "tmux";
  config.tmux.session_id = "$missing-session";
  config.tmux.leader_pane_id = "%997";
  config.tmux.hud_pane_id = "%998";
  config.tmux.worker_pane_ids = {
    "worker-1": "%996"
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await writeFile(
    resolveTeamPaneCloseRetryPath(teamName, tempRoot),
    `${JSON.stringify(
      {
        updated_at: timestamp,
        entries: [
          {
            pane_id: "%998",
            team_name: teamName,
            role: "hud",
            status: "pending",
            attempts: 1,
            first_seen_at: timestamp,
            next_attempt_at: timestamp
          },
          {
            pane_id: "%999",
            team_name: teamName,
            role: "worker",
            status: "manual_required",
            attempts: 3,
            first_seen_at: timestamp,
            next_attempt_at: timestamp
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const summary = await readTeamTmuxHealthSummary(teamName, tempRoot);
  assert.ok(summary);
  assert.equal(summary.transport, "tmux");
  assert.equal(summary.leader, "missing");
  assert.equal(summary.hud, "missing");
  assert.equal(summary.workers["worker-1"], "missing");
  assert.equal(summary.layout, "repairable");
  assert.equal(summary.retry_pending, 1);
  assert.equal(summary.retry_manual_required, 1);
  assert.deepEqual(summary.orphan_warnings.sort(), [
    "hud:missing",
    "leader:missing",
    "worker:%999:manual_required",
    "worker:worker-1:missing"
  ]);
});

test("repairTeamHudPane debounces repeated repair attempts", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-hud-debounce-"));
  const teamName = "hud-debounce-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Debounce HUD repair",
      mode: "interactive"
    },
    tempRoot
  );
  const configPath = resolveTeamConfigPath(teamName, tempRoot);
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    transport: string;
    tmux: {
      session_id?: string | null;
      leader_pane_id: string | null;
      hud_pane_id?: string | null;
      hud_refresh_ms?: number | null;
      worker_pane_ids: Record<string, string>;
    };
  };
  config.transport = "tmux";
  config.tmux.session_id = "$missing-session";
  config.tmux.leader_pane_id = "%997";
  config.tmux.hud_pane_id = "%998";
  config.tmux.hud_refresh_ms = 1000;
  config.tmux.worker_pane_ids = {};
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const first = await repairTeamHudPane(teamName, { debounceMs: 60_000 }, tempRoot);
  assert.equal(first.status, "failed");
  assert.equal(first.reason, "leader_pane_unavailable");

  const second = await repairTeamHudPane(teamName, { debounceMs: 60_000 }, tempRoot);
  assert.equal(second.status, "debounced");
  assert.equal(second.reason, "repair_debounce");

  const repairState = JSON.parse(
    await readFile(resolveTeamHudRepairPath(teamName, tempRoot), "utf8")
  ) as { recent: Array<{ status: string }> };
  assert.deepEqual(
    repairState.recent.map((entry) => entry.status),
    ["failed", "debounced"]
  );
});

test("shutdown acknowledgement protocol records accepted, busy, and rejected states", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-shutdown-acks-"));
  const teamName = "shutdown-acks-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 3,
      task: "Acknowledge shutdown states",
      mode: "interactive"
    },
    tempRoot
  );
  const acknowledgeWhenReady = async (
    workerName: string,
    status: "accepted" | "busy" | "rejected",
    options: { reason?: string; taskId?: string } = {}
  ): Promise<Record<string, unknown>> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        return await acknowledgeShutdownRequest(
          teamName,
          workerName,
          status,
          options,
          tempRoot
        );
      } catch (error) {
        lastError = error;
        if (
          !(error instanceof Error) ||
          !/shutdown not requested/i.test(error.message)
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("shutdown acknowledgement did not become ready");
  };
  const shutdownPromise = shutdownTeamRuntime(teamName, { graceMs: 100 }, tempRoot);
  await acknowledgeWhenReady("worker-1", "accepted");
  await acknowledgeWhenReady("worker-2", "busy", {
    reason: "finishing task",
    taskId: "2"
  });
  await acknowledgeWhenReady("worker-3", "rejected", {
    reason: "manual hold"
  });
  const shutdown = await shutdownPromise;
  assert.deepEqual(shutdown.shutdown_ack_aggregate, {
    accepted: 1,
    busy: 1,
    rejected: 1,
    total: 3
  });

  const status = await readTeamStatus(teamName, tempRoot);
  assert.deepEqual(status?.shutdown?.aggregate, {
    accepted: 1,
    busy: 1,
    rejected: 1,
    total: 3
  });
  assert.deepEqual(
    status?.shutdown?.acknowledgements.map((ack) => ack.source),
    ["explicit", "explicit", "explicit"]
  );
});

test("concurrent explicit shutdown acknowledgements preserve all workers and aggregate", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-concurrent-acks-"));
  const teamName = "concurrent-shutdown-acks-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 3,
      task: "Acknowledge shutdown concurrently",
      mode: "interactive"
    },
    tempRoot
  );
  const acknowledgeWhenReady = async (
    workerName: string,
    status: "accepted" | "busy" | "rejected"
  ): Promise<Record<string, unknown>> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        return await acknowledgeShutdownRequest(
          teamName,
          workerName,
          status,
          { reason: `${workerName} ${status}` },
          tempRoot
        );
      } catch (error) {
        lastError = error;
        if (
          !(error instanceof Error) ||
          !/shutdown not requested/i.test(error.message)
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("shutdown acknowledgement did not become ready");
  };

  const shutdownPromise = shutdownTeamRuntime(teamName, { graceMs: 200 }, tempRoot);
  await Promise.all([
    acknowledgeWhenReady("worker-1", "accepted"),
    acknowledgeWhenReady("worker-2", "busy"),
    acknowledgeWhenReady("worker-3", "rejected")
  ]);
  await shutdownPromise;

  const status = await readTeamStatus(teamName, tempRoot);
  assert.deepEqual(status?.shutdown?.aggregate, {
    accepted: 1,
    busy: 1,
    rejected: 1,
    total: 3
  });
  assert.deepEqual(
    status?.shutdown?.acknowledgements
      .map((ack) => `${ack.worker_name}:${ack.status}`)
      .sort(),
    ["worker-1:accepted", "worker-2:busy", "worker-3:rejected"]
  );
});

test("automatic shutdown acknowledgements preserve explicit worker decisions", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-shutdown-ack-preserve-"));
  const acknowledgeWhenReady = async (
    teamName: string,
    status: "accepted" | "busy" | "rejected"
  ): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await acknowledgeShutdownRequest(
          teamName,
          "worker-1",
          status,
          { reason: `manual ${status}` },
          tempRoot
        );
        return;
      } catch (error) {
        lastError = error;
        if (
          !(error instanceof Error) ||
          !/shutdown not requested/i.test(error.message)
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("shutdown acknowledgement did not become ready");
  };

  for (const ackStatus of ["accepted", "busy", "rejected"] as const) {
    const teamName = `shutdown-ack-preserve-${ackStatus}`;
    await startTeamRuntime(
      {
        teamName,
        workerCount: 1,
        task: "Preserve explicit shutdown ack",
        mode: "interactive"
      },
      tempRoot
    );

    const shutdownPromise = shutdownTeamRuntime(teamName, { graceMs: 100 }, tempRoot);
    await acknowledgeWhenReady(teamName, ackStatus);
    await heartbeatWorker(teamName, "worker-1", tempRoot);
    await reportWorkerStatus(teamName, "worker-1", "working", { note: "still running" }, tempRoot);
    await recordWorkerHookActivity(teamName, "worker-1", "PreToolUse", tempRoot);
    await shutdownPromise;

    const status = await readTeamStatus(teamName, tempRoot);
    const acknowledgement = status?.shutdown?.acknowledgements.find(
      (ack) => ack.worker_name === "worker-1"
    );
    assert.equal(acknowledgement?.status, ackStatus);
    assert.equal(acknowledgement?.source, "explicit");
    assert.equal(acknowledgement?.reason, `manual ${ackStatus}`);
    assert.deepEqual(status?.shutdown?.aggregate, {
      accepted: ackStatus === "accepted" ? 1 : 0,
      busy: ackStatus === "busy" ? 1 : 0,
      rejected: ackStatus === "rejected" ? 1 : 0,
      total: 1
    });
  }
});

test("runCodexFreeTeamLifecycleSmoke exercises lifecycle without Codex worker process", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-codex-free-smoke-"));
  const result = await runCodexFreeTeamLifecycleSmoke(
    {
      teamName: "codex-free-smoke-test",
      task: "Run codex-free smoke"
    },
    tempRoot
  );

  assert.equal(result.team_name, "codex-free-smoke-test");
  assert.equal(result.final_phase, "shutdown");
  assert.equal(result.final_active, false);
  assert.deepEqual(result.shutdown_ack_aggregate, {
    accepted: 1,
    busy: 0,
    rejected: 0,
    total: 1
  });
});
