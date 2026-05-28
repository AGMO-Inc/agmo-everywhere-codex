import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import os from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { appendTeamApiEvent, readTeamStatus, shutdownTeamRuntime, startTeamRuntime } from "../team/runtime.js";
import {
  resolveTeamDir,
  resolveTeamDispatchPath,
  resolveTeamEventsPath,
  resolveTeamManifestPath,
  resolveTeamMonitorSnapshotPath,
  resolveTeamShutdownPath,
  resolveTeamTaskApprovalPath,
  resolveWorkerHeartbeatPath,
  resolveWorkerIdentityPath,
  resolveWorkerInboxPath,
} from "../team/state/index.js";
import { resolveTeamWorktreeRoot } from "../team/worktree.js";
import { runTeamCommand, runTeamHudWatchLoop } from "./team.js";

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
  return (await captureTeamCommandOutput(args, cwd)).stdout;
}

async function captureTeamCommandOutput(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: string | number | null | undefined }> {
  const originalCwd = process.cwd();
  const originalProjectRoot = process.env.AGMO_PROJECT_ROOT;
  const originalExitCode = process.exitCode;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let exitCode: string | number | null | undefined;

  process.env.AGMO_PROJECT_ROOT = cwd;
  process.chdir(cwd);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"),
    );
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"),
    );
    return true;
  }) as typeof process.stderr.write;

  try {
    await runTeamCommand(args);
    exitCode = process.exitCode;
  } catch (error) {
    Object.assign(error as object, {
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
    });
    throw error;
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalStderrWrite;
    process.chdir(originalCwd);
    if (originalProjectRoot === undefined) {
      delete process.env.AGMO_PROJECT_ROOT;
    } else {
      process.env.AGMO_PROJECT_ROOT = originalProjectRoot;
    }
    process.exitCode = originalExitCode;
  }

  return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode };
}

function captureWrite(chunks: string[]): Pick<NodeJS.WriteStream, "write"> {
  return {
    write: ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
      return true;
    }) as NodeJS.WriteStream["write"],
  };
}

function assertMachineEnvelope(
  output: Record<string, unknown>,
  operation: string,
  ok = true,
): void {
  assert.equal(output.schema_version, "1.0");
  assert.equal(output.operation, operation);
  assert.equal(output.ok, ok);
}

test("runTeamCommand status prints additive machine JSON envelope for an existing team", async () => {
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

  assertMachineEnvelope(output, "team.status");
  assert.equal(output.command, "team status");
  assert.equal(output.team_name, teamName);
  assert.equal(output.found, true);
  assert.deepEqual(output.recommended_actions, []);
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

test("runTeamCommand status reports a missing team as a machine-readable miss", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-status-missing-"));
  const output = await captureTeamCommand(["status", "missing-status-team"], tempRoot);

  assertMachineEnvelope(output, "team.status", false);
  assert.equal(output.command, "team status");
  assert.equal(output.team_name, "missing-status-team");
  assert.equal(output.found, false);
  assert.deepEqual(output.recommended_actions, [
    'team start <workers> "<task>" --name missing-status-team',
  ]);
  assert.equal(output.tmux_health, null);
  assert.equal(output.status, null);
});

test("runTeamCommand team api supports read-only success operations", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-success-"));
  const teamName = "cli-api-success-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 2,
      task: "Expose read-only team API",
      mode: "interactive",
    },
    tempRoot,
  );

  const listTasks = await captureTeamCommand(
    ["api", "list-tasks", "--input", JSON.stringify({ team_name: teamName }), "--json"],
    tempRoot,
  );
  assertMachineEnvelope(listTasks, "list-tasks");
  assert.equal(listTasks.command, "team api list-tasks");
  assert.ok(listTasks.data && typeof listTasks.data === "object");
  const listData = listTasks.data as { team_name?: string; tasks?: Array<{ id: string }> };
  assert.equal(listData.team_name, teamName);
  assert.equal(listData.tasks?.length, 2);

  const readTask = await captureTeamCommand(
    [
      "api",
      "read-task",
      `--input=${JSON.stringify({ team_name: teamName, task_id: "1" })}`,
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(readTask, "read-task");
  assert.equal(readTask.command, "team api read-task");
  assert.ok(readTask.data && typeof readTask.data === "object");
  const readData = readTask.data as { team_name?: string; task?: { id?: string } };
  assert.equal(readData.team_name, teamName);
  assert.equal(readData.task?.id, "1");

  const summary = await captureTeamCommand(
    ["api", "get-summary", "--input", JSON.stringify({ team_name: teamName }), "--json"],
    tempRoot,
  );
  assertMachineEnvelope(summary, "get-summary");
  assert.equal(summary.command, "team api get-summary");
  assert.ok(summary.data && typeof summary.data === "object");
  const summaryData = summary.data as {
    team_name?: string;
    active?: boolean;
    phase?: string;
    worker_count?: number;
    task_counts?: Record<string, number>;
    workers?: Array<{ worker_name?: string; state?: string }>;
  };
  assert.equal(summaryData.team_name, teamName);
  assert.equal(summaryData.active, true);
  assert.equal(summaryData.phase, "active");
  assert.equal(summaryData.worker_count, 2);
  assert.deepEqual(summaryData.task_counts, {
    pending: 1,
    blocked: 1,
    in_progress: 0,
    completed: 0,
    failed: 0,
  });
  assert.deepEqual(
    summaryData.workers?.map((worker) => ({
      worker_name: worker.worker_name,
      state: worker.state,
    })),
    [
      { worker_name: "worker-1", state: "idle" },
      { worker_name: "worker-2", state: "idle" },
    ],
  );
});

test("runTeamCommand team api reads config and manifest snapshots", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-read-state-"));
  const teamName = "cli-api-read-state-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 2,
      task: "Read config and manifest API state",
      mode: "interactive",
    },
    tempRoot,
  );

  const config = await captureTeamCommand(
    ["api", "read-config", "--input", JSON.stringify({ team_name: teamName }), "--json"],
    tempRoot,
  );
  assertMachineEnvelope(config, "read-config");
  assert.equal(config.command, "team api read-config");
  assert.ok(config.data && typeof config.data === "object");
  const configData = config.data as { config?: { name?: string; worker_names?: string[] } };
  assert.equal(configData.config?.name, teamName);
  assert.deepEqual(configData.config?.worker_names, ["worker-1", "worker-2"]);

  const manifest = await captureTeamCommand(
    ["api", "read-manifest", "--input", JSON.stringify({ team_name: teamName }), "--json"],
    tempRoot,
  );
  assertMachineEnvelope(manifest, "read-manifest");
  assert.equal(manifest.command, "team api read-manifest");
  assert.ok(manifest.data && typeof manifest.data === "object");
  const manifestData = manifest.data as { manifest?: { team_name?: string; worker_names?: string[] } };
  assert.equal(manifestData.manifest?.team_name, teamName);
  assert.deepEqual(manifestData.manifest?.worker_names, ["worker-1", "worker-2"]);
});

test("runTeamCommand team api returns manifest_not_found for missing manifest", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-manifest-missing-"));
  const teamName = "cli-api-manifest-missing-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Read missing manifest API state",
      mode: "interactive",
    },
    tempRoot,
  );
  await rm(resolveTeamManifestPath(teamName, tempRoot));

  const result = await captureTeamCommandOutput(
    ["api", "read-manifest", "--input", JSON.stringify({ team_name: teamName }), "--json"],
    tempRoot,
  );
  const output = JSON.parse(result.stdout) as Record<string, unknown>;

  assert.equal(result.exitCode, 1);
  assertMachineEnvelope(output, "read-manifest", false);
  assert.equal(output.command, "team api read-manifest");
  assert.deepEqual(output.error, {
    code: "manifest_not_found",
    message: "manifest not found: cli-api-manifest-missing-team",
  });
  assert.equal("data" in output, false);
});

test("runTeamCommand team api reads worker status and heartbeat snapshots", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-read-worker-"));
  const teamName = "cli-api-read-worker-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Read worker API state",
      mode: "interactive",
    },
    tempRoot,
  );

  const status = await captureTeamCommand(
    [
      "api",
      "read-worker-status",
      "--input",
      JSON.stringify({ team_name: teamName, worker: "worker-1" }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(status, "read-worker-status");
  assert.equal(status.command, "team api read-worker-status");
  assert.ok(status.data && typeof status.data === "object");
  const statusData = status.data as { worker?: string; status?: { state?: string } };
  assert.equal(statusData.worker, "worker-1");
  assert.equal(statusData.status?.state, "idle");

  const heartbeat = await captureTeamCommand(
    [
      "api",
      "read-worker-heartbeat",
      "--input",
      JSON.stringify({ team_name: teamName, worker: "worker-1" }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(heartbeat, "read-worker-heartbeat");
  assert.equal(heartbeat.command, "team api read-worker-heartbeat");
  assert.ok(heartbeat.data && typeof heartbeat.data === "object");
  const heartbeatData = heartbeat.data as {
    worker?: string;
    heartbeat?: { alive?: boolean; turn_count?: number; last_turn_at?: string };
  };
  assert.equal(heartbeatData.worker, "worker-1");
  assert.equal(typeof heartbeatData.heartbeat?.alive, "boolean");
  assert.equal(heartbeatData.heartbeat?.turn_count, 0);
  assert.equal(typeof heartbeatData.heartbeat?.last_turn_at, "string");
});

test("runTeamCommand team api returns worker_not_found for missing read-only worker", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-read-worker-missing-"));
  const teamName = "cli-api-read-worker-missing-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Read missing worker API state",
      mode: "interactive",
    },
    tempRoot,
  );

  const result = await captureTeamCommandOutput(
    [
      "api",
      "read-worker-status",
      "--input",
      JSON.stringify({ team_name: teamName, worker: "worker-404" }),
      "--json",
    ],
    tempRoot,
  );
  const output = JSON.parse(result.stdout) as Record<string, unknown>;

  assert.equal(result.exitCode, 1);
  assertMachineEnvelope(output, "read-worker-status", false);
  assert.equal(output.command, "team api read-worker-status");
  assert.deepEqual(output.error, {
    code: "worker_not_found",
    message: "worker not found: worker-404",
  });
  assert.equal("data" in output, false);

  const heartbeatResult = await captureTeamCommandOutput(
    [
      "api",
      "read-worker-heartbeat",
      "--input",
      JSON.stringify({ team_name: teamName, worker: "worker-404" }),
      "--json",
    ],
    tempRoot,
  );
  const heartbeatOutput = JSON.parse(heartbeatResult.stdout) as Record<string, unknown>;

  assert.equal(heartbeatResult.exitCode, 1);
  assertMachineEnvelope(heartbeatOutput, "read-worker-heartbeat", false);
  assert.equal(heartbeatOutput.command, "team api read-worker-heartbeat");
  assert.deepEqual(heartbeatOutput.error, {
    code: "worker_not_found",
    message: "worker not found: worker-404",
  });
  assert.equal("data" in heartbeatOutput, false);
});

test("runTeamCommand team api writes worker heartbeat, inbox, and identity state", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-write-worker-"));
  const teamName = "cli-api-write-worker-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Write worker API state",
      mode: "interactive",
    },
    tempRoot,
  );

  const heartbeat = await captureTeamCommand(
    [
      "api",
      "update-worker-heartbeat",
      "--input",
      JSON.stringify({
        team_name: teamName,
        worker: "worker-1",
        turn_count: 7,
        alive: true,
        pid: 12345,
        last_turn_at: "2026-05-28T00:00:00.000Z",
      }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(heartbeat, "update-worker-heartbeat");
  const heartbeatData = heartbeat.data as {
    worker_name?: string;
    heartbeat?: { alive?: boolean; pid?: number; turn_count?: number; last_turn_at?: string };
  };
  assert.equal(heartbeatData.worker_name, "worker-1");
  assert.deepEqual(heartbeatData.heartbeat, {
    alive: true,
    pid: 12345,
    turn_count: 7,
    last_turn_at: "2026-05-28T00:00:00.000Z",
  });
  assert.deepEqual(
    JSON.parse(await readFile(resolveWorkerHeartbeatPath(teamName, "worker-1", tempRoot), "utf-8")),
    heartbeatData.heartbeat,
  );

  const inbox = await captureTeamCommand(
    [
      "api",
      "write-worker-inbox",
      "--input",
      JSON.stringify({
        team_name: teamName,
        worker: "worker-1",
        content: "Replacement inbox content\n",
      }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(inbox, "write-worker-inbox");
  const inboxData = inbox.data as { worker_name?: string; written?: boolean };
  assert.equal(inboxData.worker_name, "worker-1");
  assert.equal(inboxData.written, true);
  assert.equal(
    await readFile(resolveWorkerInboxPath(teamName, "worker-1", tempRoot), "utf-8"),
    "Replacement inbox content\n",
  );

  const identity = await captureTeamCommand(
    [
      "api",
      "write-worker-identity",
      "--input",
      JSON.stringify({
        team_name: teamName,
        worker: "worker-1",
        index: 2,
        role: "agmo-verifier",
        working_dir: "/tmp/agmo-worker",
        worktree_path: "/tmp/agmo-worker/worktree",
        team_state_root: "/tmp/agmo-team-state",
        pane_id: "%7",
        git_branch: "api-worker-state",
      }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(identity, "write-worker-identity");
  const identityData = identity.data as {
    worker_name?: string;
    identity?: {
      name?: string;
      index?: number;
      role?: string;
      working_dir?: string;
      worktree_path?: string;
      team_state_root?: string;
      pane_id?: string;
      git_branch?: string;
    };
  };
  assert.equal(identityData.worker_name, "worker-1");
  assert.deepEqual(identityData.identity, {
    name: "worker-1",
    index: 2,
    role: "agmo-verifier",
    working_dir: "/tmp/agmo-worker",
    worktree_path: "/tmp/agmo-worker/worktree",
    team_state_root: "/tmp/agmo-team-state",
    pane_id: "%7",
    git_branch: "api-worker-state",
  });
  assert.deepEqual(
    JSON.parse(await readFile(resolveWorkerIdentityPath(teamName, "worker-1", tempRoot), "utf-8")),
    identityData.identity,
  );
});

test("runTeamCommand team api rejects invalid worker state write input", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-write-worker-invalid-"));
  const teamName = "cli-api-write-worker-invalid-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Reject invalid worker write API input",
      mode: "interactive",
    },
    tempRoot,
  );

  const heartbeatResult = await captureTeamCommandOutput(
    [
      "api",
      "update-worker-heartbeat",
      "--input",
      JSON.stringify({
        team_name: teamName,
        worker: "worker-1",
        turn_count: -1,
        alive: true,
      }),
      "--json",
    ],
    tempRoot,
  );
  const heartbeatOutput = JSON.parse(heartbeatResult.stdout) as Record<string, unknown>;
  assert.equal(heartbeatResult.exitCode, 1);
  assertMachineEnvelope(heartbeatOutput, "update-worker-heartbeat", false);
  assert.deepEqual(heartbeatOutput.error, {
    code: "invalid_input",
    message: "turn_count must be a non-negative integer",
  });

  const inboxResult = await captureTeamCommandOutput(
    [
      "api",
      "write-worker-inbox",
      "--input",
      JSON.stringify({ team_name: teamName, worker: "worker-1", content: "" }),
      "--json",
    ],
    tempRoot,
  );
  const inboxOutput = JSON.parse(inboxResult.stdout) as Record<string, unknown>;
  assert.equal(inboxResult.exitCode, 1);
  assertMachineEnvelope(inboxOutput, "write-worker-inbox", false);
  assert.deepEqual(inboxOutput.error, {
    code: "invalid_input",
    message: "content is required",
  });

  const identityResult = await captureTeamCommandOutput(
    [
      "api",
      "write-worker-identity",
      "--input",
      JSON.stringify({ team_name: teamName, worker: "worker-1", index: 0, role: "agmo-verifier" }),
      "--json",
    ],
    tempRoot,
  );
  const identityOutput = JSON.parse(identityResult.stdout) as Record<string, unknown>;
  assert.equal(identityResult.exitCode, 1);
  assertMachineEnvelope(identityOutput, "write-worker-identity", false);
  assert.deepEqual(identityOutput.error, {
    code: "invalid_input",
    message: "index must be a positive integer",
  });
});

test("runTeamCommand team api returns worker_not_found for missing worker state writes", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-write-worker-missing-"));
  const teamName = "cli-api-write-worker-missing-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Reject missing worker API state writes",
      mode: "interactive",
    },
    tempRoot,
  );

  const cases = [
    {
      operation: "update-worker-heartbeat",
      input: { team_name: teamName, worker: "worker-404", turn_count: 1, alive: true },
    },
    {
      operation: "write-worker-inbox",
      input: { team_name: teamName, worker: "worker-404", content: "Replacement inbox" },
    },
    {
      operation: "write-worker-identity",
      input: { team_name: teamName, worker: "worker-404", index: 1, role: "agmo-verifier" },
    },
  ];

  for (const { operation, input } of cases) {
    const result = await captureTeamCommandOutput(
      ["api", operation, "--input", JSON.stringify(input), "--json"],
      tempRoot,
    );
    const output = JSON.parse(result.stdout) as Record<string, unknown>;

    assert.equal(result.exitCode, 1);
    assertMachineEnvelope(output, operation, false);
    assert.deepEqual(output.error, {
      code: "worker_not_found",
      message: "worker not found: worker-404",
    });
    assert.equal("data" in output, false);
  }
});

test("runTeamCommand team api appends strict team events", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-append-event-"));
  const teamName = "cli-api-append-event-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Append event API state",
      mode: "interactive",
    },
    tempRoot,
  );

  const result = await captureTeamCommand(
    [
      "api",
      "append-event",
      "--input",
      JSON.stringify({
        team_name: teamName,
        type: "task_completed",
        worker: "worker-1",
        task_id: "1",
        message_id: null,
        reason: "verified",
        metadata: { source: "cli-test" },
      }),
      "--json",
    ],
    tempRoot,
  );

  assertMachineEnvelope(result, "append-event");
  assert.equal(result.command, "team api append-event");
  const data = result.data as {
    team_name?: string;
    event?: {
      event_id?: string;
      team?: string;
      team_name?: string;
      type?: string;
      worker?: string;
      worker_name?: string;
      task_id?: string;
      message_id?: string | null;
      reason?: string;
      metadata?: Record<string, unknown>;
      created_at?: string;
      timestamp?: string;
    };
  };
  assert.equal(data.team_name, teamName);
  assert.match(data.event?.event_id ?? "", /^evt-/);
  assert.equal(data.event?.team, teamName);
  assert.equal(data.event?.team_name, teamName);
  assert.equal(data.event?.type, "task_completed");
  assert.equal(data.event?.worker, "worker-1");
  assert.equal(data.event?.worker_name, "worker-1");
  assert.equal(data.event?.task_id, "1");
  assert.equal(data.event?.message_id, null);
  assert.equal(data.event?.reason, "verified");
  assert.deepEqual(data.event?.metadata, { source: "cli-test" });
  assert.match(data.event?.created_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(data.event?.timestamp, data.event?.created_at);

  const eventLines = (await readFile(resolveTeamEventsPath(teamName, tempRoot), "utf-8"))
    .trim()
    .split("\n");
  const persisted = JSON.parse(eventLines[eventLines.length - 1] ?? "{}") as Record<string, unknown>;
  assert.deepEqual(persisted, data.event);
});

test("runTeamCommand team api rejects invalid append-event input", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-append-event-invalid-"));
  const teamName = "cli-api-append-event-invalid-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Reject invalid append event input",
      mode: "interactive",
    },
    tempRoot,
  );

  const invalidTypeResult = await captureTeamCommandOutput(
    [
      "api",
      "append-event",
      "--input",
      JSON.stringify({ team_name: teamName, type: "not_an_event", worker: "worker-1" }),
      "--json",
    ],
    tempRoot,
  );
  const invalidType = JSON.parse(invalidTypeResult.stdout) as Record<string, unknown>;
  assert.equal(invalidTypeResult.exitCode, 1);
  assertMachineEnvelope(invalidType, "append-event", false);
  assert.equal((invalidType.error as { code?: string }).code, "invalid_input");
  assert.match((invalidType.error as { message?: string }).message ?? "", /type must be one of:/);

  const missingWorkerResult = await captureTeamCommandOutput(
    [
      "api",
      "append-event",
      "--input",
      JSON.stringify({ team_name: teamName, type: "task_completed", worker: "worker-404" }),
      "--json",
    ],
    tempRoot,
  );
  const missingWorker = JSON.parse(missingWorkerResult.stdout) as Record<string, unknown>;
  assert.equal(missingWorkerResult.exitCode, 1);
  assertMachineEnvelope(missingWorker, "append-event", false);
  assert.deepEqual(missingWorker.error, {
    code: "worker_not_found",
    message: "worker not found: worker-404",
  });

  const invalidMetadataResult = await captureTeamCommandOutput(
    [
      "api",
      "append-event",
      "--input",
      JSON.stringify({ team_name: teamName, type: "task_completed", worker: "worker-1", metadata: [] }),
      "--json",
    ],
    tempRoot,
  );
  const invalidMetadata = JSON.parse(invalidMetadataResult.stdout) as Record<string, unknown>;
  assert.equal(invalidMetadataResult.exitCode, 1);
  assertMachineEnvelope(invalidMetadata, "append-event", false);
  assert.deepEqual(invalidMetadata.error, {
    code: "invalid_input",
    message: "metadata must be an object when provided",
  });
});

test("runTeamCommand team api reads canonical filtered team events", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-read-events-"));
  const teamName = "cli-api-read-events-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 2,
      task: "Read event API state",
      mode: "interactive",
    },
    tempRoot,
  );

  const first = await captureTeamCommand(
    [
      "api",
      "append-event",
      "--input",
      JSON.stringify({ team_name: teamName, type: "task_completed", worker: "worker-2", task_id: "2" }),
      "--json",
    ],
    tempRoot,
  );
  const firstEventId = ((first.data as { event?: { event_id?: string } }).event?.event_id) ?? "";

  const second = await captureTeamCommand(
    [
      "api",
      "append-event",
      "--input",
      JSON.stringify({
        team_name: teamName,
        type: "worker_idle",
        worker: "worker-1",
        task_id: "1",
        prev_state: "working",
      }),
      "--json",
    ],
    tempRoot,
  );
  const secondEventId = ((second.data as { event?: { event_id?: string } }).event?.event_id) ?? "";

  await captureTeamCommand(
    [
      "api",
      "append-event",
      "--input",
      JSON.stringify({ team_name: teamName, type: "task_failed", worker: "worker-1", task_id: "1" }),
      "--json",
    ],
    tempRoot,
  );

  const result = await captureTeamCommand(
    [
      "api",
      "read-events",
      "--input",
      JSON.stringify({
        team_name: teamName,
        after_event_id: firstEventId,
        worker: "worker-1",
        task_id: "1",
        type: "worker_idle",
      }),
      "--json",
    ],
    tempRoot,
  );

  assertMachineEnvelope(result, "read-events");
  const data = result.data as {
    count?: number;
    cursor?: string;
    events?: Array<{ event_id?: string; type?: string; source_type?: string; worker?: string; task_id?: string; state?: string }>;
  };
  assert.equal(data.count, 1);
  assert.equal(data.cursor, secondEventId);
  assert.equal(data.events?.length, 1);
  assert.equal(data.events?.[0]?.event_id, secondEventId);
  assert.equal(data.events?.[0]?.type, "worker_state_changed");
  assert.equal(data.events?.[0]?.source_type, "worker_idle");
  assert.equal(data.events?.[0]?.worker, "worker-1");
  assert.equal(data.events?.[0]?.task_id, "1");
  assert.equal(data.events?.[0]?.state, "idle");
});

test("runTeamCommand team api awaits the next matching event", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-await-event-"));
  const teamName = "cli-api-await-event-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 2,
      task: "Await event API state",
      mode: "interactive",
    },
    tempRoot,
  );

  const oldMatching = await appendTeamApiEvent(
    teamName,
    { type: "task_completed", worker: "worker-1", taskId: "1" },
    tempRoot,
  );
  const oldEventId = ((oldMatching.event as { event_id?: string } | undefined)?.event_id) ?? "";

  const waitPromise = captureTeamCommand(
    [
      "api",
      "await-event",
      "--input",
      JSON.stringify({
        team_name: teamName,
        worker: "worker-1",
        task_id: "1",
        type: "task_completed",
        timeout_ms: 500,
        poll_ms: 25,
      }),
      "--json",
    ],
    tempRoot,
  );

  setTimeout(() => {
    void appendTeamApiEvent(
      teamName,
      { type: "worker_state_changed", worker: "worker-2", taskId: "2", state: "working" },
      tempRoot,
    );
  }, 25);
  setTimeout(() => {
    void appendTeamApiEvent(
      teamName,
      { type: "task_completed", worker: "worker-1", taskId: "1" },
      tempRoot,
    );
  }, 60);

  const result = await waitPromise;

  assertMachineEnvelope(result, "await-event");
  const data = result.data as {
    status?: string;
    cursor?: string;
    event?: { event_id?: string; type?: string; worker?: string; task_id?: string } | null;
  };
  assert.equal(data.status, "event");
  assert.match(data.cursor ?? "", /^evt-/);
  assert.notEqual(data.event?.event_id, oldEventId);
  assert.equal(data.event?.type, "task_completed");
  assert.equal(data.event?.worker, "worker-1");
  assert.equal(data.event?.task_id, "1");
});

test("runTeamCommand team api rejects invalid event read filters", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-read-events-invalid-"));
  const teamName = "cli-api-read-events-invalid-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Reject invalid event read filters",
      mode: "interactive",
    },
    tempRoot,
  );

  const readResult = await captureTeamCommandOutput(
    [
      "api",
      "read-events",
      "--input",
      JSON.stringify({ team_name: teamName, type: "not_an_event" }),
      "--json",
    ],
    tempRoot,
  );
  const readOutput = JSON.parse(readResult.stdout) as Record<string, unknown>;
  assert.equal(readResult.exitCode, 1);
  assertMachineEnvelope(readOutput, "read-events", false);
  assert.equal((readOutput.error as { code?: string }).code, "invalid_input");
  assert.match((readOutput.error as { message?: string }).message ?? "", /type must be one of:/);

  const awaitResult = await captureTeamCommandOutput(
    [
      "api",
      "await-event",
      "--input",
      JSON.stringify({ team_name: teamName, timeout_ms: -1 }),
      "--json",
    ],
    tempRoot,
  );
  const awaitOutput = JSON.parse(awaitResult.stdout) as Record<string, unknown>;
  assert.equal(awaitResult.exitCode, 1);
  assertMachineEnvelope(awaitOutput, "await-event", false);
  assert.deepEqual(awaitOutput.error, {
    code: "invalid_input",
    message: "timeout_ms must be a non-negative integer when provided",
  });

  const pollResult = await captureTeamCommandOutput(
    [
      "api",
      "await-event",
      "--input",
      JSON.stringify({ team_name: teamName, poll_ms: -1 }),
      "--json",
    ],
    tempRoot,
  );
  const pollOutput = JSON.parse(pollResult.stdout) as Record<string, unknown>;
  assert.equal(pollResult.exitCode, 1);
  assertMachineEnvelope(pollOutput, "await-event", false);
  assert.deepEqual(pollOutput.error, {
    code: "invalid_input",
    message: "poll_ms must be a non-negative integer when provided",
  });
});

test("runTeamCommand team api reads and writes monitor snapshots", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-monitor-snapshot-"));
  const teamName = "cli-api-monitor-snapshot-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Expose monitor snapshot API state",
      mode: "interactive",
    },
    tempRoot,
  );

  const missing = await captureTeamCommand(
    [
      "api",
      "read-monitor-snapshot",
      "--input",
      JSON.stringify({ team_name: teamName }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(missing, "read-monitor-snapshot");
  const missingData = missing.data as {
    team_name?: string;
    found?: boolean;
    snapshot?: unknown;
  };
  assert.equal(missingData.team_name, teamName);
  assert.equal(missingData.found, false);
  assert.equal(missingData.snapshot, null);

  const snapshot = {
    checked_at: "2026-05-28T00:00:00.000Z",
    workerStateByName: { "worker-1": "idle" },
    workerAliveByName: { "worker-1": true },
    taskStatusById: { "1": "pending" },
  };
  const write = await captureTeamCommand(
    [
      "api",
      "write-monitor-snapshot",
      "--input",
      JSON.stringify({ team_name: teamName, snapshot }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(write, "write-monitor-snapshot");
  const writeData = write.data as {
    team_name?: string;
    written?: boolean;
    snapshot?: Record<string, unknown>;
  };
  assert.equal(writeData.team_name, teamName);
  assert.equal(writeData.written, true);
  assert.deepEqual(writeData.snapshot, {
    ...snapshot,
    team_name: teamName,
  });
  assert.deepEqual(
    JSON.parse(await readFile(resolveTeamMonitorSnapshotPath(teamName, tempRoot), "utf-8")),
    writeData.snapshot,
  );

  const read = await captureTeamCommand(
    [
      "api",
      "read-monitor-snapshot",
      "--input",
      JSON.stringify({ team_name: teamName }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(read, "read-monitor-snapshot");
  const readData = read.data as {
    team_name?: string;
    found?: boolean;
    snapshot?: Record<string, unknown>;
  };
  assert.equal(readData.team_name, teamName);
  assert.equal(readData.found, true);
  assert.deepEqual(readData.snapshot, writeData.snapshot);

  const eventLines = (await readFile(resolveTeamEventsPath(teamName, tempRoot), "utf-8"))
    .trim()
    .split("\n");
  const persistedEvent = JSON.parse(eventLines[eventLines.length - 1] ?? "{}") as Record<string, unknown>;
  assert.equal(persistedEvent.type, "team_monitor_snapshot");
  assert.equal(persistedEvent.source, "team_api");
  assert.equal(persistedEvent.snapshot_checked_at, snapshot.checked_at);
});

test("runTeamCommand team api rejects invalid monitor snapshot writes", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-monitor-snapshot-invalid-"));
  const teamName = "cli-api-monitor-snapshot-invalid-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Reject invalid monitor snapshot API writes",
      mode: "interactive",
    },
    tempRoot,
  );

  const missingSnapshotResult = await captureTeamCommandOutput(
    [
      "api",
      "write-monitor-snapshot",
      "--input",
      JSON.stringify({ team_name: teamName }),
      "--json",
    ],
    tempRoot,
  );
  const missingSnapshot = JSON.parse(missingSnapshotResult.stdout) as Record<string, unknown>;
  assert.equal(missingSnapshotResult.exitCode, 1);
  assertMachineEnvelope(missingSnapshot, "write-monitor-snapshot", false);
  assert.deepEqual(missingSnapshot.error, {
    code: "invalid_input",
    message: "snapshot is required",
  });

  const arraySnapshotResult = await captureTeamCommandOutput(
    [
      "api",
      "write-monitor-snapshot",
      "--input",
      JSON.stringify({ team_name: teamName, snapshot: [] }),
      "--json",
    ],
    tempRoot,
  );
  const arraySnapshot = JSON.parse(arraySnapshotResult.stdout) as Record<string, unknown>;
  assert.equal(arraySnapshotResult.exitCode, 1);
  assertMachineEnvelope(arraySnapshot, "write-monitor-snapshot", false);
  assert.deepEqual(arraySnapshot.error, {
    code: "invalid_input",
    message: "snapshot must be an object when provided",
  });

  const mismatchResult = await captureTeamCommandOutput(
    [
      "api",
      "write-monitor-snapshot",
      "--input",
      JSON.stringify({ team_name: teamName, snapshot: { team_name: "other-team" } }),
      "--json",
    ],
    tempRoot,
  );
  const mismatch = JSON.parse(mismatchResult.stdout) as Record<string, unknown>;
  assert.equal(mismatchResult.exitCode, 1);
  assertMachineEnvelope(mismatch, "write-monitor-snapshot", false);
  assert.deepEqual(mismatch.error, {
    code: "runtime_error",
    message: `snapshot team_name must match team_name: ${teamName}`,
  });
});

test("runTeamCommand team api writes shutdown requests and reads acknowledgements", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-shutdown-handshake-"));
  const teamName = "cli-api-shutdown-handshake-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Expose shutdown handshake API state",
      mode: "interactive",
    },
    tempRoot,
  );

  const initialAck = await captureTeamCommand(
    [
      "api",
      "read-shutdown-ack",
      "--input",
      JSON.stringify({ team_name: teamName, worker: "worker-1" }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(initialAck, "read-shutdown-ack");
  assert.equal((initialAck.data as { ack?: unknown }).ack, null);
  assert.equal((initialAck.data as { shutdown_request?: unknown }).shutdown_request, null);

  const request = await captureTeamCommand(
    [
      "api",
      "write-shutdown-request",
      "--input",
      JSON.stringify({
        team_name: teamName,
        worker: "worker-1",
        requested_by: "leader-fixed",
        grace_ms: 250,
      }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(request, "write-shutdown-request");
  const requestData = request.data as {
    worker?: string;
    shutdown_request?: {
      requested?: boolean;
      requested_by?: string;
      requested_worker?: string;
      grace_ms?: number;
      aggregate?: Record<string, number>;
    };
  };
  assert.equal(requestData.worker, "worker-1");
  assert.equal(requestData.shutdown_request?.requested, true);
  assert.equal(requestData.shutdown_request?.requested_by, "leader-fixed");
  assert.equal(requestData.shutdown_request?.requested_worker, "worker-1");
  assert.equal(requestData.shutdown_request?.grace_ms, 250);
  assert.deepEqual(requestData.shutdown_request?.aggregate, {
    accepted: 0,
    busy: 0,
    rejected: 0,
    total: 0,
  });

  const statusAfterRequest = await captureTeamCommand(["status", teamName], tempRoot);
  const statusData = statusAfterRequest.status as { config?: { active?: boolean }; phase?: { current_phase?: string } };
  assert.equal(statusData.config?.active, true);
  assert.equal(statusData.phase?.current_phase, "active");

  const persistedRequest = JSON.parse(
    await readFile(resolveTeamShutdownPath(teamName, tempRoot), "utf-8"),
  ) as Record<string, unknown>;
  assert.equal(persistedRequest.requested, true);
  assert.equal(persistedRequest.requested_by, "leader-fixed");
  assert.equal(persistedRequest.requested_worker, "worker-1");

  const ackOutput = await captureTeamCommand(
    [
      "shutdown-ack",
      teamName,
      "worker-1",
      "accepted",
      "--reason",
      "api handshake accepted",
      "--task",
      "1",
    ],
    tempRoot,
  );
  const ackedAt = (ackOutput.acknowledgement as { acked_at?: string }).acked_at ?? "";
  assert.match(ackedAt, /^\d{4}-\d{2}-\d{2}T/);

  const readAck = await captureTeamCommand(
    [
      "api",
      "read-shutdown-ack",
      "--input",
      JSON.stringify({ team_name: teamName, worker: "worker-1" }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(readAck, "read-shutdown-ack");
  const readAckData = readAck.data as {
    ack?: { status?: string; source?: string; reason?: string; task_id?: string; acked_at?: string } | null;
    shutdown_request?: { requested_by?: string; requested_worker?: string; aggregate?: Record<string, number> } | null;
  };
  assert.equal(readAckData.ack?.status, "accepted");
  assert.equal(readAckData.ack?.source, "explicit");
  assert.equal(readAckData.ack?.reason, "api handshake accepted");
  assert.equal(readAckData.ack?.task_id, "1");
  assert.equal(readAckData.ack?.acked_at, ackedAt);
  assert.equal(readAckData.shutdown_request?.requested_by, "leader-fixed");
  assert.equal(readAckData.shutdown_request?.requested_worker, "worker-1");
  assert.deepEqual(readAckData.shutdown_request?.aggregate, {
    accepted: 1,
    busy: 0,
    rejected: 0,
    total: 1,
  });

  const staleRead = await captureTeamCommand(
    [
      "api",
      "read-shutdown-ack",
      "--input",
      JSON.stringify({
        team_name: teamName,
        worker: "worker-1",
        min_updated_at: "2999-01-01T00:00:00.000Z",
      }),
      "--json",
    ],
    tempRoot,
  );
  assert.equal((staleRead.data as { ack?: unknown }).ack, null);

  const eventLines = (await readFile(resolveTeamEventsPath(teamName, tempRoot), "utf-8"))
    .trim()
    .split("\n");
  const requestEvent = eventLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((event) => event.type === "shutdown_gate");
  assert.equal(requestEvent?.worker_name, "worker-1");
  assert.equal(requestEvent?.requested_by, "leader-fixed");
});

test("runTeamCommand team api rejects invalid shutdown handshake input", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-shutdown-invalid-"));
  const teamName = "cli-api-shutdown-invalid-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Reject invalid shutdown handshake API input",
      mode: "interactive",
    },
    tempRoot,
  );

  const missingRequestedByResult = await captureTeamCommandOutput(
    [
      "api",
      "write-shutdown-request",
      "--input",
      JSON.stringify({ team_name: teamName, worker: "worker-1" }),
      "--json",
    ],
    tempRoot,
  );
  const missingRequestedBy = JSON.parse(missingRequestedByResult.stdout) as Record<string, unknown>;
  assert.equal(missingRequestedByResult.exitCode, 1);
  assertMachineEnvelope(missingRequestedBy, "write-shutdown-request", false);
  assert.deepEqual(missingRequestedBy.error, {
    code: "invalid_input",
    message: "requested_by is required",
  });

  const invalidGraceResult = await captureTeamCommandOutput(
    [
      "api",
      "write-shutdown-request",
      "--input",
      JSON.stringify({
        team_name: teamName,
        worker: "worker-1",
        requested_by: "leader-fixed",
        grace_ms: -1,
      }),
      "--json",
    ],
    tempRoot,
  );
  const invalidGrace = JSON.parse(invalidGraceResult.stdout) as Record<string, unknown>;
  assert.equal(invalidGraceResult.exitCode, 1);
  assertMachineEnvelope(invalidGrace, "write-shutdown-request", false);
  assert.deepEqual(invalidGrace.error, {
    code: "invalid_input",
    message: "grace_ms must be a non-negative integer when provided",
  });

  const missingWorkerResult = await captureTeamCommandOutput(
    [
      "api",
      "read-shutdown-ack",
      "--input",
      JSON.stringify({ team_name: teamName, worker: "worker-404" }),
      "--json",
    ],
    tempRoot,
  );
  const missingWorker = JSON.parse(missingWorkerResult.stdout) as Record<string, unknown>;
  assert.equal(missingWorkerResult.exitCode, 1);
  assertMachineEnvelope(missingWorker, "read-shutdown-ack", false);
  assert.deepEqual(missingWorker.error, {
    code: "worker_not_found",
    message: "worker not found: worker-404",
  });
});

test("runTeamCommand team api reads idle state from durable worker status and events", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-idle-state-"));
  const teamName = "cli-api-idle-state-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 2,
      task: "Expose idle state API",
      mode: "interactive",
    },
    tempRoot,
  );

  await captureTeamCommand(
    [
      "api",
      "append-event",
      "--input",
      JSON.stringify({
        team_name: teamName,
        type: "worker_idle",
        worker: "worker-1",
        prev_state: "working",
      }),
      "--json",
    ],
    tempRoot,
  );
  await captureTeamCommand(
    [
      "api",
      "append-event",
      "--input",
      JSON.stringify({
        team_name: teamName,
        type: "all_workers_idle",
        worker: "leader-fixed",
        worker_count: 2,
      }),
      "--json",
    ],
    tempRoot,
  );
  await captureTeamCommand(["report", teamName, "worker-2", "working"], tempRoot);

  const result = await captureTeamCommand(
    ["api", "read-idle-state", "--input", JSON.stringify({ team_name: teamName }), "--json"],
    tempRoot,
  );

  assertMachineEnvelope(result, "read-idle-state");
  const data = result.data as {
    worker_count?: number;
    idle_worker_count?: number;
    idle_workers?: string[];
    non_idle_workers?: string[];
    all_workers_idle?: boolean;
    last_idle_transition_by_worker?: Record<string, { type?: string; source_type?: string; state?: string } | null>;
    last_all_workers_idle_event?: { type?: string; worker_count?: number } | null;
    source?: { summary_available?: boolean; snapshot_available?: boolean; recent_event_count?: number };
  };
  assert.equal(data.worker_count, 2);
  assert.equal(data.idle_worker_count, 1);
  assert.deepEqual(data.idle_workers, ["worker-1"]);
  assert.deepEqual(data.non_idle_workers, ["worker-2"]);
  assert.equal(data.all_workers_idle, false);
  assert.equal(data.last_idle_transition_by_worker?.["worker-1"]?.type, "worker_state_changed");
  assert.equal(data.last_idle_transition_by_worker?.["worker-1"]?.source_type, "worker_idle");
  assert.equal(data.last_idle_transition_by_worker?.["worker-1"]?.state, "idle");
  assert.equal(data.last_idle_transition_by_worker?.["worker-2"], null);
  assert.equal(data.last_all_workers_idle_event?.type, "all_workers_idle");
  assert.equal(data.last_all_workers_idle_event?.worker_count, 2);
  assert.equal(data.source?.summary_available, true);
  assert.equal(data.source?.snapshot_available, false);
  assert.ok((data.source?.recent_event_count ?? 0) >= 2);
});

test("runTeamCommand team api reads stall state from durable heartbeats and dispatch", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-stall-state-"));
  const teamName = "cli-api-stall-state-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Expose stall state API",
      mode: "interactive",
    },
    tempRoot,
  );

  await captureTeamCommand(
    [
      "api",
      "update-worker-heartbeat",
      "--input",
      JSON.stringify({
        team_name: teamName,
        worker: "worker-1",
        turn_count: 1,
        alive: false,
        last_turn_at: "2026-05-28T00:00:00.000Z",
      }),
      "--json",
    ],
    tempRoot,
  );
  await writeFile(
    resolveTeamDispatchPath(teamName, tempRoot),
    `${JSON.stringify(
      [
        {
          request_id: "req-leader-1",
          kind: "inbox",
          to_worker: "leader-fixed",
          status: "pending",
          created_at: "2026-05-28T00:00:00.000Z",
        },
      ],
      null,
      2,
    )}\n`,
    "utf-8",
  );
  await captureTeamCommand(
    [
      "api",
      "append-event",
      "--input",
      JSON.stringify({
        team_name: teamName,
        type: "team_leader_nudge",
        worker: "leader-fixed",
        reason: "pending decision",
      }),
      "--json",
    ],
    tempRoot,
  );

  const result = await captureTeamCommand(
    ["api", "read-stall-state", "--input", JSON.stringify({ team_name: teamName }), "--json"],
    tempRoot,
  );

  assertMachineEnvelope(result, "read-stall-state");
  const data = result.data as {
    team_stalled?: boolean;
    leader_attention_pending?: boolean;
    leader_decision_state?: string;
    dead_workers?: string[];
    live_workers?: string[];
    pending_task_count?: number;
    pending_leader_dispatch_count?: number;
    reasons?: string[];
    last_team_leader_nudge_event?: { type?: string; reason?: string } | null;
    source?: { summary_available?: boolean; phase_available?: boolean; recent_event_count?: number };
  };
  assert.equal(data.team_stalled, true);
  assert.equal(data.leader_attention_pending, true);
  assert.equal(data.leader_decision_state, "still_actionable");
  assert.deepEqual(data.dead_workers, ["worker-1"]);
  assert.deepEqual(data.live_workers, []);
  assert.ok((data.pending_task_count ?? 0) > 0);
  assert.equal(data.pending_leader_dispatch_count, 1);
  assert.ok(data.reasons?.includes("dead_workers_with_pending_work:worker-1"));
  assert.ok(data.reasons?.includes("leader_attention_pending:leader_dispatch_pending"));
  assert.equal(data.last_team_leader_nudge_event?.type, "team_leader_nudge");
  assert.equal(data.last_team_leader_nudge_event?.reason, "pending decision");
  assert.equal(data.source?.summary_available, true);
  assert.equal(data.source?.phase_available, true);
  assert.ok((data.source?.recent_event_count ?? 0) >= 1);
});

test("runTeamCommand team api reads and writes task approvals", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-task-approval-"));
  const teamName = "cli-api-task-approval-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Expose task approval API",
      mode: "interactive",
    },
    tempRoot,
  );

  const missing = await captureTeamCommand(
    [
      "api",
      "read-task-approval",
      "--input",
      JSON.stringify({ team_name: teamName, task_id: "1" }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(missing, "read-task-approval");
  assert.equal((missing.data as { approval?: unknown }).approval, null);

  const write = await captureTeamCommand(
    [
      "api",
      "write-task-approval",
      "--input",
      JSON.stringify({
        team_name: teamName,
        task_id: "1",
        required: false,
        status: "approved",
        reviewer: "leader-fixed",
        decision_reason: "plan is verified",
      }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(write, "write-task-approval");
  const writeData = write.data as {
    approval?: {
      task_id?: string;
      required?: boolean;
      status?: string;
      reviewer?: string;
      decision_reason?: string;
      decided_at?: string;
    };
  };
  assert.deepEqual(
    {
      task_id: writeData.approval?.task_id,
      required: writeData.approval?.required,
      status: writeData.approval?.status,
      reviewer: writeData.approval?.reviewer,
      decision_reason: writeData.approval?.decision_reason,
    },
    {
      task_id: "1",
      required: false,
      status: "approved",
      reviewer: "leader-fixed",
      decision_reason: "plan is verified",
    },
  );
  assert.match(writeData.approval?.decided_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(
    JSON.parse(await readFile(resolveTeamTaskApprovalPath(teamName, "1", tempRoot), "utf-8")),
    writeData.approval,
  );

  const read = await captureTeamCommand(
    [
      "api",
      "read-task-approval",
      "--input",
      JSON.stringify({ team_name: teamName, task_id: "1" }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(read, "read-task-approval");
  assert.deepEqual((read.data as { approval?: unknown }).approval, writeData.approval);

  const eventLines = (await readFile(resolveTeamEventsPath(teamName, tempRoot), "utf-8"))
    .trim()
    .split("\n");
  const approvalEvent = eventLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((event) => event.type === "approval_decision");
  assert.equal(approvalEvent?.worker, "leader-fixed");
  assert.equal(approvalEvent?.task_id, "1");
  assert.equal(approvalEvent?.status, "approved");
  assert.equal(approvalEvent?.reason, "approved:plan is verified");
});

test("runTeamCommand team api rejects invalid task approval input", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-task-approval-invalid-"));
  const teamName = "cli-api-task-approval-invalid-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Reject invalid task approval API input",
      mode: "interactive",
    },
    tempRoot,
  );

  const invalidStatusResult = await captureTeamCommandOutput(
    [
      "api",
      "write-task-approval",
      "--input",
      JSON.stringify({
        team_name: teamName,
        task_id: "1",
        status: "maybe",
        reviewer: "leader-fixed",
        decision_reason: "invalid",
      }),
      "--json",
    ],
    tempRoot,
  );
  const invalidStatus = JSON.parse(invalidStatusResult.stdout) as Record<string, unknown>;
  assert.equal(invalidStatusResult.exitCode, 1);
  assertMachineEnvelope(invalidStatus, "write-task-approval", false);
  assert.deepEqual(invalidStatus.error, {
    code: "invalid_input",
    message: "status must be one of: pending, approved, rejected",
  });

  const missingTaskResult = await captureTeamCommandOutput(
    [
      "api",
      "read-task-approval",
      "--input",
      JSON.stringify({ team_name: teamName, task_id: "404" }),
      "--json",
    ],
    tempRoot,
  );
  const missingTask = JSON.parse(missingTaskResult.stdout) as Record<string, unknown>;
  assert.equal(missingTaskResult.exitCode, 1);
  assertMachineEnvelope(missingTask, "read-task-approval", false);
  assert.deepEqual(missingTask.error, {
    code: "task_not_found",
    message: "task not found: 404",
  });

  const missingReviewerResult = await captureTeamCommandOutput(
    [
      "api",
      "write-task-approval",
      "--input",
      JSON.stringify({
        team_name: teamName,
        task_id: "1",
        status: "approved",
        reviewer: "worker-404",
        decision_reason: "unknown reviewer",
      }),
      "--json",
    ],
    tempRoot,
  );
  const missingReviewer = JSON.parse(missingReviewerResult.stdout) as Record<string, unknown>;
  assert.equal(missingReviewerResult.exitCode, 1);
  assertMachineEnvelope(missingReviewer, "write-task-approval", false);
  assert.deepEqual(missingReviewer.error, {
    code: "worker_not_found",
    message: "worker not found: worker-404",
  });
});

test("runTeamCommand team api sends, lists, and marks mailbox messages delivered", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-mailbox-"));
  const teamName = "cli-api-mailbox-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Exercise mailbox message API",
      mode: "interactive",
    },
    tempRoot,
  );

  const send = await captureTeamCommand(
    [
      "api",
      "send-message",
      "--input",
      JSON.stringify({
        team_name: teamName,
        from_worker: "leader-fixed",
        to_worker: "worker-1",
        body: "Check the handoff note",
      }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(send, "send-message");
  assert.equal(send.command, "team api send-message");
  const sendData = send.data as {
    message?: {
      message_id?: string;
      from_worker?: string;
      to_worker?: string;
      body?: string;
      delivered_at?: string;
    };
    dispatch?: {
      message_id?: string;
      dispatch_request_id?: string;
      dispatch_status?: string;
    };
  };
  assert.equal(sendData.message?.from_worker, "leader-fixed");
  assert.equal(sendData.message?.to_worker, "worker-1");
  assert.equal(sendData.message?.body, "Check the handoff note");
  assert.equal(sendData.message?.message_id, sendData.dispatch?.message_id);
  assert.equal(sendData.dispatch?.dispatch_status, "pending");

  const list = await captureTeamCommand(
    [
      "api",
      "mailbox-list",
      "--input",
      JSON.stringify({ team_name: teamName, worker: "worker-1" }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(list, "mailbox-list");
  const listData = list.data as {
    worker?: string;
    count?: number;
    messages?: Array<{ message_id?: string; delivered_at?: string }>;
  };
  assert.equal(listData.worker, "worker-1");
  assert.ok((listData.count ?? 0) >= 1);
  assert.ok(
    listData.messages?.some((message) => message.message_id === sendData.message?.message_id),
  );

  const delivered = await captureTeamCommand(
    [
      "api",
      "mailbox-mark-delivered",
      "--input",
      JSON.stringify({
        team_name: teamName,
        worker: "worker-1",
        message_id: sendData.message?.message_id,
      }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(delivered, "mailbox-mark-delivered");
  const deliveredData = delivered.data as {
    updated?: boolean;
    dispatch_request_id?: string | null;
    dispatch_updated?: boolean;
  };
  assert.equal(deliveredData.updated, true);
  assert.equal(deliveredData.dispatch_request_id, sendData.dispatch?.dispatch_request_id);
  assert.equal(deliveredData.dispatch_updated, true);

  const openList = await captureTeamCommand(
    [
      "api",
      "mailbox-list",
      "--input",
      JSON.stringify({
        team_name: teamName,
        worker: "worker-1",
        include_delivered: false,
      }),
      "--json",
    ],
    tempRoot,
  );
  const openListData = openList.data as { count?: number; messages?: unknown[] };
  assert.equal(
    openListData.messages?.some(
      (message) =>
        Boolean(message) &&
        typeof message === "object" &&
        (message as { message_id?: string }).message_id === sendData.message?.message_id,
    ),
    false,
  );
});

test("runTeamCommand team api broadcasts to all workers except the sender", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-broadcast-"));
  const teamName = "cli-api-broadcast-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 3,
      task: "Exercise mailbox broadcast API",
      mode: "interactive",
    },
    tempRoot,
  );

  const broadcast = await captureTeamCommand(
    [
      "api",
      "broadcast",
      "--input",
      JSON.stringify({
        team_name: teamName,
        from_worker: "worker-1",
        body: "Shared coordination note",
      }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(broadcast, "broadcast");
  assert.equal(broadcast.command, "team api broadcast");
  const broadcastData = broadcast.data as {
    count?: number;
    messages?: Array<{ worker_name?: string; from_worker?: string }>;
  };
  assert.equal(broadcastData.count, 2);
  assert.deepEqual(
    broadcastData.messages?.map((message) => message.worker_name),
    ["worker-2", "worker-3"],
  );
  assert.deepEqual(
    broadcastData.messages?.map((message) => message.from_worker),
    ["worker-1", "worker-1"],
  );

  const senderMailbox = await captureTeamCommand(
    [
      "api",
      "mailbox-list",
      "--input",
      JSON.stringify({ team_name: teamName, worker: "worker-1" }),
      "--json",
    ],
    tempRoot,
  );
  const senderMailboxData = senderMailbox.data as {
    messages?: Array<{ body?: string }>;
  };
  assert.equal(
    senderMailboxData.messages?.some((message) => message.body === "Shared coordination note"),
    false,
  );

  const recipientMailbox = await captureTeamCommand(
    [
      "api",
      "mailbox-list",
      "--input",
      JSON.stringify({ team_name: teamName, worker: "worker-2" }),
      "--json",
    ],
    tempRoot,
  );
  const recipientMailboxData = recipientMailbox.data as {
    count?: number;
    messages?: Array<{ from_worker?: string; body?: string }>;
  };
  assert.ok((recipientMailboxData.count ?? 0) >= 1);
  assert.ok(
    recipientMailboxData.messages?.some(
      (message) =>
        message.from_worker === "worker-1" &&
        message.body === "Shared coordination note",
    ),
  );

  const invalidSenderResult = await captureTeamCommandOutput(
    [
      "api",
      "broadcast",
      "--input",
      JSON.stringify({
        team_name: teamName,
        from_worker: "worker-404",
        body: "Invalid sender",
      }),
      "--json",
    ],
    tempRoot,
  );
  const invalidSender = JSON.parse(invalidSenderResult.stdout) as Record<string, unknown>;
  assert.equal(invalidSenderResult.exitCode, 1);
  assertMachineEnvelope(invalidSender, "broadcast", false);
  assert.deepEqual(invalidSender.error, {
    code: "worker_not_found",
    message: "worker not found: worker-404",
  });
});

test("runTeamCommand team api creates tasks visible to list and read", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-create-"));
  const teamName = "cli-api-create-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 2,
      task: "Expose task creation API",
      mode: "interactive",
    },
    tempRoot,
  );

  const create = await captureTeamCommand(
    [
      "api",
      "create-task",
      "--input",
      JSON.stringify({
        team_name: teamName,
        subject: "Dynamic follow-up",
        description: "Created through the team API",
        owner: "worker-1",
        blocked_by: ["1"],
      }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(create, "create-task");
  assert.equal(create.command, "team api create-task");
  const createData = create.data as {
    task?: {
      id?: string;
      owner?: string;
      role?: string;
      status?: string;
      depends_on?: string[];
      requires_code_change?: boolean;
      version?: number;
    };
  };
  assert.equal(createData.task?.id, "3");
  assert.equal(createData.task?.owner, "worker-1");
  assert.equal(createData.task?.role, "agmo-executor");
  assert.equal(createData.task?.status, "blocked");
  assert.deepEqual(createData.task?.depends_on, ["1"]);
  assert.equal(createData.task?.requires_code_change, true);
  assert.equal(createData.task?.version, 1);

  const list = await captureTeamCommand(
    ["api", "list-tasks", "--input", JSON.stringify({ team_name: teamName }), "--json"],
    tempRoot,
  );
  const listData = list.data as { tasks?: Array<{ id?: string }> };
  assert.deepEqual(listData.tasks?.map((task) => task.id), ["1", "2", "3"]);

  const read = await captureTeamCommand(
    [
      "api",
      "read-task",
      "--input",
      JSON.stringify({ team_name: teamName, task_id: "3" }),
      "--json",
    ],
    tempRoot,
  );
  const readData = read.data as { task?: { subject?: string } };
  assert.equal(readData.task?.subject, "Dynamic follow-up");
});

test("runTeamCommand team api update-task rejects lifecycle fields", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-update-"));
  const teamName = "cli-api-update-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Reject lifecycle task mutation",
      mode: "interactive",
    },
    tempRoot,
  );

  const update = await captureTeamCommand(
    [
      "api",
      "update-task",
      "--input",
      JSON.stringify({
        team_name: teamName,
        task_id: "1",
        subject: "Allowed metadata",
        description: "Updated metadata only",
        requires_code_change: false,
      }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(update, "update-task");
  assert.equal(update.command, "team api update-task");
  const updateData = update.data as {
    task?: {
      subject?: string;
      description?: string;
      requires_code_change?: boolean;
      status?: string;
      version?: number;
    };
  };
  assert.equal(updateData.task?.subject, "Allowed metadata");
  assert.equal(updateData.task?.description, "Updated metadata only");
  assert.equal(updateData.task?.requires_code_change, false);
  assert.equal(updateData.task?.status, "pending");
  assert.equal(updateData.task?.version, 2);

  const result = await captureTeamCommandOutput(
    [
      "api",
      "update-task",
      "--input",
      JSON.stringify({
        team_name: teamName,
        task_id: "1",
        subject: "Allowed metadata",
        status: "completed",
      }),
      "--json",
    ],
    tempRoot,
  );
  const output = JSON.parse(result.stdout) as Record<string, unknown>;

  assert.equal(result.exitCode, 1);
  assertMachineEnvelope(output, "update-task", false);
  assert.equal(output.command, "team api update-task");
  assert.deepEqual(output.error, {
    code: "invalid_input",
    message: "update-task cannot mutate lifecycle fields: status",
  });
});

test("runTeamCommand team api supports claim-safe terminal transitions", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-transition-"));
  const teamName = "cli-api-transition-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Expose claim-safe lifecycle API",
      mode: "interactive",
    },
    tempRoot,
  );

  const claim = await captureTeamCommand(
    [
      "api",
      "claim-task",
      "--input",
      JSON.stringify({
        team_name: teamName,
        task_id: "1",
        worker: "worker-1",
        expected_version: 1,
      }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(claim, "claim-task");
  assert.equal(claim.command, "team api claim-task");
  assert.ok(claim.data && typeof claim.data === "object");
  const claimData = claim.data as {
    claimToken?: string;
    claim_token?: string;
    task?: { status?: string; claim?: { token?: string } };
  };
  assert.equal(typeof claimData.claimToken, "string");
  assert.equal(claimData.claim_token, claimData.claimToken);
  assert.equal(claimData.task?.status, "in_progress");
  assert.equal(claimData.task?.claim?.token, claimData.claimToken);

  const badTransitionResult = await captureTeamCommandOutput(
    [
      "api",
      "transition-task-status",
      "--input",
      JSON.stringify({
        team_name: teamName,
        task_id: "1",
        from: "in_progress",
        to: "completed",
        claim_token: "not-the-claim-token",
      }),
      "--json",
    ],
    tempRoot,
  );
  const badTransition = JSON.parse(badTransitionResult.stdout) as Record<string, unknown>;
  assert.equal(badTransitionResult.exitCode, 1);
  assertMachineEnvelope(badTransition, "transition-task-status", false);
  assert.deepEqual(badTransition.error, {
    code: "claim_conflict",
    message: "claim token mismatch for task 1",
  });

  const transition = await captureTeamCommand(
    [
      "api",
      "transition-task-status",
      "--input",
      JSON.stringify({
        team_name: teamName,
        task_id: "1",
        from: "in_progress",
        to: "completed",
        claim_token: claimData.claimToken,
        result: "lifecycle complete",
      }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(transition, "transition-task-status");
  assert.equal(transition.command, "team api transition-task-status");
  assert.ok(transition.data && typeof transition.data === "object");
  const transitionData = transition.data as {
    task?: { status?: string; result?: string; claim?: unknown };
    auto_shutdown?: { triggered?: boolean };
  };
  assert.equal(transitionData.task?.status, "completed");
  assert.equal(transitionData.task?.result, "lifecycle complete");
  assert.equal(transitionData.task?.claim, undefined);
  assert.equal(transitionData.auto_shutdown?.triggered, true);
});

test("runTeamCommand team api release-task-claim requires token and makes task claimable", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-release-"));
  const teamName = "cli-api-release-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Release task claim through API",
      mode: "interactive",
    },
    tempRoot,
  );

  const claim = await captureTeamCommand(
    [
      "api",
      "claim-task",
      "--input",
      JSON.stringify({
        team_name: teamName,
        task_id: "1",
        worker: "worker-1",
      }),
      "--json",
    ],
    tempRoot,
  );
  const claimData = claim.data as { claimToken?: string };
  assert.equal(typeof claimData.claimToken, "string");

  const badReleaseResult = await captureTeamCommandOutput(
    [
      "api",
      "release-task-claim",
      "--input",
      JSON.stringify({
        team_name: teamName,
        task_id: "1",
        worker: "worker-1",
        claim_token: "not-the-claim-token",
      }),
      "--json",
    ],
    tempRoot,
  );
  const badRelease = JSON.parse(badReleaseResult.stdout) as Record<string, unknown>;
  assert.equal(badReleaseResult.exitCode, 1);
  assertMachineEnvelope(badRelease, "release-task-claim", false);
  assert.deepEqual(badRelease.error, {
    code: "claim_conflict",
    message: "claim token mismatch for task 1",
  });

  const release = await captureTeamCommand(
    [
      "api",
      "release-task-claim",
      "--input",
      JSON.stringify({
        team_name: teamName,
        task_id: "1",
        worker: "worker-1",
        claim_token: claimData.claimToken,
      }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(release, "release-task-claim");
  assert.equal(release.command, "team api release-task-claim");
  const releaseData = release.data as {
    task?: {
      status?: string;
      owner?: string;
      claim?: unknown;
      claim_history?: Array<{ release_reason?: string }>;
    };
    worker_marked_idle?: boolean;
  };
  assert.equal(releaseData.task?.status, "pending");
  assert.equal(releaseData.task?.owner, undefined);
  assert.equal(releaseData.task?.claim, undefined);
  assert.equal(releaseData.task?.claim_history?.at(-1)?.release_reason, "released");
  assert.equal(releaseData.worker_marked_idle, true);

  const secondClaim = await captureTeamCommand(
    [
      "api",
      "claim-task",
      "--input",
      JSON.stringify({
        team_name: teamName,
        task_id: "1",
        worker: "worker-1",
      }),
      "--json",
    ],
    tempRoot,
  );
  const secondClaimData = secondClaim.data as { task?: { status?: string; claim?: { token?: string } } };
  assert.equal(secondClaimData.task?.status, "in_progress");
  assert.equal(typeof secondClaimData.task?.claim?.token, "string");
});

test("runTeamCommand team api returns ok false envelope for missing team", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-missing-"));
  const result = await captureTeamCommandOutput(
    ["api", "get-summary", "--input", JSON.stringify({ team_name: "missing-api-team" }), "--json"],
    tempRoot,
  );
  const output = JSON.parse(result.stdout) as Record<string, unknown>;

  assert.equal(result.exitCode, 1);
  assertMachineEnvelope(output, "get-summary", false);
  assert.equal(output.command, "team api get-summary");
  assert.deepEqual(output.error, {
    code: "team_not_found",
    message: "team not found: missing-api-team",
  });
  assert.equal("data" in output, false);
});

test("runTeamCommand team api returns ok false envelopes for invalid input and missing task", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-errors-"));
  const teamName = "cli-api-error-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Expose API errors",
      mode: "interactive",
    },
    tempRoot,
  );

  const invalidInputResult = await captureTeamCommandOutput(
    ["api", "list-tasks", "--json"],
    tempRoot,
  );
  const invalidInput = JSON.parse(invalidInputResult.stdout) as Record<string, unknown>;

  assert.equal(invalidInputResult.exitCode, 1);
  assertMachineEnvelope(invalidInput, "list-tasks", false);
  assert.equal(invalidInput.command, "team api list-tasks");
  assert.deepEqual(invalidInput.error, {
    code: "invalid_input",
    message: "--input is required",
  });

  const missingTaskResult = await captureTeamCommandOutput(
    [
      "api",
      "read-task",
      "--input",
      JSON.stringify({ team_name: teamName, task_id: "missing-task" }),
      "--json",
    ],
    tempRoot,
  );
  const missingTask = JSON.parse(missingTaskResult.stdout) as Record<string, unknown>;

  assert.equal(missingTaskResult.exitCode, 1);
  assertMachineEnvelope(missingTask, "read-task", false);
  assert.equal(missingTask.command, "team api read-task");
  assert.deepEqual(missingTask.error, {
    code: "task_not_found",
    message: "task not found: missing-task",
  });
});

test("runTeamCommand team api cleanup reports missing team without deleting state", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-cleanup-missing-"));
  const result = await captureTeamCommandOutput(
    ["api", "cleanup", "--input", JSON.stringify({ team_name: "missing-cleanup-team" }), "--json"],
    tempRoot,
  );
  const output = JSON.parse(result.stdout) as Record<string, unknown>;

  assert.equal(result.exitCode, 1);
  assertMachineEnvelope(output, "cleanup", false);
  assert.equal(output.command, "team api cleanup");
  assert.deepEqual(output.error, {
    code: "team_not_found",
    message: "team not found: missing-cleanup-team",
  });
  assert.equal(existsSync(resolveTeamDir("missing-cleanup-team", tempRoot)), false);
});

test("runTeamCommand team api cleanup defaults to dry-run until confirmed", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-cleanup-dry-run-"));
  const teamName = "cli-api-cleanup-dry-run-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Dry-run cleanup through API",
      mode: "interactive",
    },
    tempRoot,
  );

  const output = await captureTeamCommand(
    ["api", "cleanup", "--input", JSON.stringify({ team_name: teamName }), "--json"],
    tempRoot,
  );
  assertMachineEnvelope(output, "cleanup");
  assert.equal(output.command, "team api cleanup");
  const data = output.data as {
    team_name?: string;
    cleanup_mode?: string;
    dry_run?: boolean;
    requires_confirmation?: boolean;
    status?: string;
    active?: boolean;
    recommended_actions?: string[];
  };
  assert.equal(data.team_name, teamName);
  assert.equal(data.cleanup_mode, "shutdown");
  assert.equal(data.dry_run, true);
  assert.equal(data.requires_confirmation, true);
  assert.equal(data.status, "confirmation_required");
  assert.equal(data.active, true);
  assert.ok(data.recommended_actions?.some((action) => action.includes("confirm_cleanup")));

  const status = await readTeamStatus(teamName, tempRoot);
  assert.equal(status?.config.active, true);
  assert.equal(status?.phase.current_phase, "active");
});

test("runTeamCommand team api cleanup shuts down only when explicitly confirmed", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-cleanup-confirmed-"));
  const teamName = "cli-api-cleanup-confirmed-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Confirmed cleanup through API",
      mode: "interactive",
    },
    tempRoot,
  );

  const output = await captureTeamCommand(
    [
      "api",
      "cleanup",
      "--input",
      JSON.stringify({ team_name: teamName, confirm_cleanup: true }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(output, "cleanup");
  assert.equal(output.command, "team api cleanup");
  const data = output.data as {
    team_name?: string;
    cleanup_mode?: string;
    dry_run?: boolean;
    confirmed?: boolean;
    shutdown?: { current_phase?: string; preserved_state_root?: string };
  };
  assert.equal(data.team_name, teamName);
  assert.equal(data.cleanup_mode, "shutdown");
  assert.equal(data.dry_run, false);
  assert.equal(data.confirmed, true);
  assert.equal(data.shutdown?.current_phase, "shutdown");
  assert.equal(data.shutdown?.preserved_state_root, resolveTeamDir(teamName, tempRoot));

  const status = await readTeamStatus(teamName, tempRoot);
  assert.equal(status?.config.active, false);
  assert.equal(status?.phase.current_phase, "shutdown");
  assert.equal(existsSync(resolveTeamDir(teamName, tempRoot)), true);
});

test("runTeamCommand team api orphan-cleanup defaults to dry-run envelope", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-api-orphan-cleanup-"));
  const teamName = "cli-api-orphan-cleanup-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Dry-run orphan cleanup through API",
      mode: "interactive",
    },
    tempRoot,
  );

  const output = await captureTeamCommand(
    [
      "api",
      "orphan-cleanup",
      "--input",
      JSON.stringify({ team_name: teamName, dry_run: false }),
      "--json",
    ],
    tempRoot,
  );
  assertMachineEnvelope(output, "orphan-cleanup");
  assert.equal(output.command, "team api orphan-cleanup");
  const data = output.data as {
    team_name?: string;
    cleanup_mode?: string;
    dry_run?: boolean;
    requires_confirmation?: boolean;
    cleanup?: { checked_at?: string; cleaned?: unknown[]; tmux_sweep?: unknown };
  };
  assert.equal(data.team_name, teamName);
  assert.equal(data.cleanup_mode, "orphan_cleanup");
  assert.equal(data.dry_run, true);
  assert.equal(data.requires_confirmation, true);
  assert.equal(typeof data.cleanup?.checked_at, "string");
  assert.ok(Array.isArray(data.cleanup?.cleaned));
  assert.ok(data.cleanup?.tmux_sweep && typeof data.cleanup.tmux_sweep === "object");

  const status = await readTeamStatus(teamName, tempRoot);
  assert.equal(status?.config.active, true);
  assert.equal(status?.phase.current_phase, "active");
});

test("runTeamCommand cleanup-stale prints additive machine JSON envelope", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-cleanup-stale-"));
  const output = await captureTeamCommand(["cleanup-stale", "--dry-run"], tempRoot);

  assertMachineEnvelope(output, "team.cleanup-stale");
  assert.equal(output.command, "team cleanup-stale");
  assert.deepEqual(output.recommended_actions, []);
  assert.equal(output.team_count, 0);
  assert.equal(output.active_team_count, 0);
  assert.ok(Array.isArray(output.cleaned));
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

  assertMachineEnvelope(output, "team.shutdown-ack");
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

test("runTeamCommand start rejects invalid spec inputs before writing team state", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-start-validation-"));

  await assert.rejects(
    () => captureTeamCommandOutput(["start", "2x", "Bad worker count"], tempRoot),
    /worker count must be an integer between 1 and 20/,
  );
  await assert.rejects(
    () => captureTeamCommandOutput(["start", "21", "Too many workers"], tempRoot),
    /worker count must be an integer between 1 and 20/,
  );
  await assert.rejects(
    () => captureTeamCommandOutput(["start", "1", "Bad name", "--name", "Bad Name"], tempRoot),
    /--name must match/,
  );
  await assert.rejects(
    () =>
      captureTeamCommandOutput(
        ["start", "1", "Bad role worker", "--name", "bad-role-worker", "--role-map", "worker-2=agmo-executor"],
        tempRoot,
      ),
    /unknown worker: worker-2/,
  );
  await assert.rejects(
    () =>
      captureTeamCommandOutput(
        ["start", "1", "Bad role name", "--name", "bad-role-name", "--role-map", "worker-1=executor"],
        tempRoot,
      ),
    /must be one of: agmo-planner/,
  );
  await assert.rejects(
    () =>
      captureTeamCommandOutput(
        ["start", "1", "Bad HUD refresh", "--name", "bad-hud-refresh", "--hud-refresh-ms", "100"],
        tempRoot,
      ),
    /--hud-refresh-ms must be at least 250/,
  );
  await assert.rejects(
    () => captureTeamCommandOutput(["start", "1", "Missing name value", "--name"], tempRoot),
    /--name requires a value/,
  );

  assert.equal(existsSync(resolveTeamDir("bad-role-worker", tempRoot)), false);
  assert.equal(existsSync(resolveTeamDir("bad-role-name", tempRoot)), false);
  assert.equal(existsSync(resolveTeamDir("bad-hud-refresh", tempRoot)), false);
});

test("runTeamCommand delete refuses active teams without force", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-delete-active-"));
  const teamName = "cli-delete-active-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Refuse active delete",
      mode: "interactive",
    },
    tempRoot,
  );

  const output = await captureTeamCommand(["delete", teamName], tempRoot);

  assertMachineEnvelope(output, "team.delete");
  assert.equal(output.command, "team delete");
  assert.equal(output.team_name, teamName);
  assert.equal(output.status, "refused_active");
  assert.equal(existsSync(resolveTeamDir(teamName, tempRoot)), true);
  assert.equal(existsSync(resolveTeamWorktreeRoot(teamName, tempRoot)), true);
});

test("runTeamCommand delete dry-run reports intended deletion without removing state or worktrees", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-delete-dry-run-"));
  const teamName = "cli-delete-dry-run-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Dry-run team delete",
      mode: "interactive",
    },
    tempRoot,
  );
  await shutdownTeamRuntime(teamName, { graceMs: 0 }, tempRoot);

  const output = await captureTeamCommand(["delete", teamName, "--dry-run"], tempRoot);

  assertMachineEnvelope(output, "team.delete");
  assert.equal(output.command, "team delete");
  assert.equal(output.status, "would_delete");
  assert.equal((output.state_removal as { status?: string }).status, "would_remove");
  assert.equal((output.worktree_cleanup as { status?: string }).status, "would_remove");
  assert.equal(existsSync(resolveTeamDir(teamName, tempRoot)), true);
  assert.equal(existsSync(resolveTeamWorktreeRoot(teamName, tempRoot)), true);
});

test("runTeamCommand delete force shuts down active teams and removes state safely", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-delete-force-"));
  const teamName = "cli-delete-force-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Force delete active team",
      mode: "interactive",
    },
    tempRoot,
  );

  const output = await captureTeamCommand(["delete", teamName, "--force"], tempRoot);

  assertMachineEnvelope(output, "team.delete");
  assert.equal(output.command, "team delete");
  assert.equal(output.status, "deleted");
  assert.ok(output.shutdown && typeof output.shutdown === "object");
  assert.equal((output.state_removal as { status?: string }).status, "removed");
  assert.equal(existsSync(resolveTeamDir(teamName, tempRoot)), false);
  assert.equal(existsSync(resolveTeamWorktreeRoot(teamName, tempRoot)), false);
});

test("runTeamCommand delete keep-worktrees removes state but preserves owned worktree root", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-delete-keep-worktrees-"));
  const teamName = "cli-delete-keep-worktrees-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Delete team but keep worktrees",
      mode: "interactive",
    },
    tempRoot,
  );
  await shutdownTeamRuntime(teamName, { graceMs: 0 }, tempRoot);

  const output = await captureTeamCommand(["delete", teamName, "--keep-worktrees"], tempRoot);

  assertMachineEnvelope(output, "team.delete");
  assert.equal(output.command, "team delete");
  assert.equal(output.status, "deleted");
  assert.equal((output.worktree_cleanup as { status?: string }).status, "skipped");
  assert.equal((output.state_removal as { status?: string }).status, "removed");
  assert.equal(existsSync(resolveTeamDir(teamName, tempRoot)), false);
  assert.equal(existsSync(resolveTeamWorktreeRoot(teamName, tempRoot)), true);
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

test("runTeamCommand hud accepts sidecar preset and rejects invalid presets", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-hud-sidecar-"));
  const teamName = "cli-hud-sidecar-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Render HUD sidecar preset",
      mode: "interactive",
    },
    tempRoot,
  );

  const output = await captureTeamCommandText(
    ["hud", teamName, "--preset", "sidecar", "--width", "90", "--max-lines", "6", "--no-color"],
    tempRoot,
  );

  assert.match(output, /AGMO sidecar/);
  assert.match(output, /workers worker-1:/);
  assert.match(output, /task /);
  assert.doesNotMatch(output, /\x1b\[/);
  for (const line of output.trimEnd().split("\n")) {
    assert.ok(line.length <= 90, line);
  }

  await assert.rejects(
    () => runTeamCommand(["hud", teamName, "--preset", "wide"]),
    /--preset must be one of: minimal, sidecar, focused, full/,
  );
});

test("runTeamCommand hud json emits a machine envelope with rendered text", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-hud-json-"));
  const teamName = "cli-hud-json-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Render HUD as JSON",
      mode: "interactive",
    },
    tempRoot,
  );

  const output = await captureTeamCommand(
    [
      "hud",
      teamName,
      "--json",
      "--preset",
      "sidecar",
      "--width",
      "90",
      "--max-lines",
      "6",
      "--no-color",
    ],
    tempRoot,
  );

  assertMachineEnvelope(output, "team.hud");
  assert.equal(output.command, "team hud");
  assert.equal(output.team_name, teamName);
  assert.equal(output.preset, "sidecar");
  assert.equal(output.width, 90);
  assert.equal(output.max_lines, 6);
  assert.equal(output.legend, false);
  assert.equal(typeof output.path, "string");
  assert.equal(typeof output.text, "string");
  assert.match(output.text as string, /AGMO sidecar/);
  assert.match(output.text as string, /workers worker-1:/);
  assert.doesNotMatch(output.text as string, /\x1b\[/);

  await assert.rejects(
    () => runTeamCommand(["hud", teamName, "--json", "--watch"]),
    /--json cannot be used with --watch/,
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

test("runTeamCommand hud non-watch output remains footer-free", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-hud-no-watch-footer-"));
  const teamName = "cli-hud-no-watch-footer-team";

  await startTeamRuntime(
    {
      teamName,
      workerCount: 1,
      task: "Render HUD without watch footer",
      mode: "interactive",
    },
    tempRoot,
  );

  const output = await captureTeamCommandText(
    ["hud", teamName, "--width", "80", "--no-color"],
    tempRoot,
  );

  assert.match(output, /AGMO HUD/);
  assert.doesNotMatch(output, /watch refresh=/);
  assert.doesNotMatch(output, /\x1b\[H\x1b\[2J/);
});

test("runTeamCommand hud non-watch render failure remains stderr-free", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-hud-no-watch-error-"));
  let output: { stdout: string; stderr: string } | undefined;

  await assert.rejects(
    async () => {
      try {
        output = await captureTeamCommandOutput(
          ["hud", "missing-team", "--width", "80", "--no-color"],
          tempRoot,
        );
      } catch (error) {
        output = {
          stdout: (error as { stdout?: string }).stdout ?? "",
          stderr: (error as { stderr?: string }).stderr ?? "",
        };
        throw error;
      }
    },
    /team not found: missing-team/,
  );

  assert.equal(output?.stdout ?? "", "");
  assert.equal(output?.stderr ?? "", "");
});

test("runTeamHudWatchLoop suppresses duplicate clear-screen frames only in clear mode", async () => {
  const renderFrame = async () => "same frame";
  const sleepFn = async () => {};
  const clearChunks: string[] = [];
  const noClearChunks: string[] = [];
  const stderrChunks: string[] = [];

  await runTeamHudWatchLoop({
    watch: true,
    clearScreen: true,
    iterations: 2,
    intervalMs: 250,
    renderFrame,
    sleepFn,
    streams: {
      stdout: captureWrite(clearChunks),
      stderr: captureWrite(stderrChunks),
    },
  });

  await runTeamHudWatchLoop({
    watch: true,
    clearScreen: false,
    iterations: 2,
    intervalMs: 250,
    renderFrame,
    sleepFn,
    streams: {
      stdout: captureWrite(noClearChunks),
      stderr: captureWrite(stderrChunks),
    },
  });

  assert.equal(clearChunks.join(""), "\x1b[H\x1b[2Jsame frame\n");
  assert.equal(noClearChunks.join(""), "same frame\nsame frame\n");
  assert.deepEqual(stderrChunks, []);
});

test("runTeamCommand hud watch render failure writes bounded stderr without partial clear frame", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-team-cli-hud-watch-error-"));
  let output: { stdout: string; stderr: string } | undefined;

  await assert.rejects(
    async () => {
      try {
        output = await captureTeamCommandOutput(
          [
            "hud",
            "missing-team",
            "--watch",
            "--iterations",
            "1",
            "--refresh-ms",
            "250",
            "--width",
            "80",
            "--no-color",
          ],
          tempRoot,
        );
      } catch (error) {
        output = {
          stdout: (error as { stdout?: string }).stdout ?? output?.stdout ?? "",
          stderr: (error as { stderr?: string }).stderr ?? output?.stderr ?? "",
        };
        throw error;
      }
    },
    /team not found: missing-team/,
  );

  assert.equal(output?.stdout ?? "", "");
  assert.match(output?.stderr ?? "", /^watch render error: team not found: missing-team\n$/);
  assert.ok((output?.stderr ?? "").length <= 201);
  assert.doesNotMatch(output?.stdout ?? "", /\x1b\[H\x1b\[2J/);
});

test("runTeamHudWatchLoop unregisters SIGINT handler and stops cleanly", async () => {
  const stdoutChunks: string[] = [];
  const signalHandlers = new Set<() => void>();
  const signalProcess = {
    on: (signal: string, handler: () => void) => {
      assert.equal(signal, "SIGINT");
      signalHandlers.add(handler);
      return signalProcess;
    },
    off: (signal: string, handler: () => void) => {
      assert.equal(signal, "SIGINT");
      signalHandlers.delete(handler);
      return signalProcess;
    },
  };
  let renders = 0;

  await runTeamHudWatchLoop({
    watch: true,
    clearScreen: false,
    iterations: 3,
    intervalMs: 250,
    renderFrame: async () => {
      renders += 1;
      return `frame ${renders}`;
    },
    sleepFn: async () => {
      for (const handler of signalHandlers) {
        handler();
      }
    },
    streams: {
      stdout: captureWrite(stdoutChunks),
      stderr: captureWrite([]),
    },
    signalProcess,
  });

  assert.equal(renders, 1);
  assert.equal(stdoutChunks.join(""), "frame 1\n");
  assert.equal(signalHandlers.size, 0);
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
  assertMachineEnvelope(status, "team.layout.status");
  assert.equal(status.command, "team layout status");
  assert.equal(status.team_name, teamName);
  assert.equal(status.transport, "none");
  assert.equal(status.dry_run, false);
  assert.equal(status.layout_health, "skipped");
  assert.ok(status.panes && typeof status.panes === "object");
  assert.equal(status.layout_plan, undefined);
  assert.deepEqual(status.recommended_actions, []);

  const repair = await captureTeamCommand(
    ["layout", "repair", teamName, "--dry-run"],
    tempRoot,
  );
  assertMachineEnvelope(repair, "team.layout.repair");
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
  assertMachineEnvelope(rebalance, "team.layout.rebalance");
  assert.equal(rebalance.command, "team layout rebalance");
  assert.equal(rebalance.team_name, teamName);
  assert.equal(rebalance.dry_run, true);
  assert.equal(rebalance.status, "skipped");
  assert.deepEqual(rebalance.performed, []);
  assert.deepEqual(rebalance.failed, []);
  assert.deepEqual(rebalance.refused, []);
});
