import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { shutdownTeamRuntime, startTeamRuntime } from "../team/runtime.js";
import { resolveTeamDir } from "../team/state/index.js";
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
