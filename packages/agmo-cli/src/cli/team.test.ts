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

  return JSON.parse(stdoutChunks.join("")) as Record<string, unknown>;
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
