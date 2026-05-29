import assert from "node:assert/strict";
import os from "node:os";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runDoctorCommand } from "./doctor.js";

test("runDoctorCommand reports launch workspace cleanup guidance without legacy runtime recommendations", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-doctor-cmd-project-"));
  const tempHome = await mkdtemp(join(os.tmpdir(), "agmo-doctor-cmd-home-"));

  await mkdir(join(tempProject, ".codex", "agents"), { recursive: true });
  await mkdir(join(tempProject, ".agmo", "state"), { recursive: true });
  await mkdir(join(tempProject, ".agmo", "cache", "launch-workspaces"), { recursive: true });

  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const stdoutChunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);

  process.env.HOME = tempHome;
  process.chdir(tempProject);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as typeof process.stdout.write;

  try {
    await runDoctorCommand(["--scope", "project"]);
  } finally {
    process.stdout.write = originalWrite;
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  const output = JSON.parse(stdoutChunks.join(""));
  assert.deepEqual(Object.keys(output).sort(), [
    "agents_md",
    "checks",
    "command",
    "launch_policy",
    "launch_workspaces",
    "ok",
    "operation",
    "paths",
    "recommendations",
    "recommended_actions",
    "schema_version",
    "scope",
    "team_worktrees",
    "vault",
  ]);
  assert.equal(output.schema_version, "1.0");
  assert.equal(output.operation, "doctor");
  assert.equal(typeof output.ok, "boolean");
  assert.equal(output.command, "doctor");
  assert.equal(output.scope, "project");
  assert.ok(output.checks && typeof output.checks === "object");
  assert.ok(output.recommendations && typeof output.recommendations === "object");
  assert.ok(output.paths && typeof output.paths === "object");
  assert.ok(output.vault && typeof output.vault === "object");
  assert.ok(output.launch_workspaces && typeof output.launch_workspaces === "object");
  assert.ok(output.team_worktrees && typeof output.team_worktrees === "object");
  assert.ok(Array.isArray(output.recommended_actions));
  assert.equal("legacy_runtime" in output, false);
  assert.equal("legacy_runtime" in output.recommendations, false);
  assert.ok(Array.isArray(output.recommendations.setup));
  assert.ok(Array.isArray(output.recommendations.team_worktrees));
});

test("runDoctorCommand reports Agmo worktree leftovers that need manual review", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-doctor-worktrees-project-"));
  const tempHome = await mkdtemp(join(os.tmpdir(), "agmo-doctor-worktrees-home-"));

  await mkdir(join(tempProject, ".codex", "agents"), { recursive: true });
  await mkdir(join(tempProject, ".agmo", "state"), { recursive: true });
  await mkdir(join(tempProject, ".agmo", "worktrees", "orphaned-team", "worker-1"), {
    recursive: true
  });

  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const stdoutChunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);

  process.env.HOME = tempHome;
  process.chdir(tempProject);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as typeof process.stdout.write;

  try {
    await runDoctorCommand(["--scope", "project"]);
  } finally {
    process.stdout.write = originalWrite;
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  const output = JSON.parse(stdoutChunks.join(""));
  assert.equal(output.ok, false);
  assert.equal(output.team_worktrees.counts.teams, 1);
  assert.equal(output.team_worktrees.counts.missing_manifest, 1);
  assert.equal(output.team_worktrees.counts.manual_review_required, 1);
  assert.equal(output.team_worktrees.teams[0].manifest_status, "missing");
  assert.deepEqual(output.team_worktrees.teams[0].reasons, [
    "missing_manifest",
    "manual_review_required"
  ]);
  assert.match(output.recommendations.team_worktrees[0].message, /without ownership manifests/);
  assert.equal(
    output.recommendations.team_worktrees[0].command,
    "find .agmo/worktrees -mindepth 1 -maxdepth 2 -print"
  );
  assert.ok(
    output.recommended_actions.includes("find .agmo/worktrees -mindepth 1 -maxdepth 2 -print")
  );
});
