import assert from "node:assert/strict";
import os from "node:os";
import { mkdir, mkdtemp, realpath, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { buildDoctorDiskUsage, runDoctorCommand, type DoctorDiskUsageDeps } from "./doctor.js";

async function captureDoctorCommand(args: string[], cwd: string, home: string): Promise<any> {
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const stdoutChunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);

  process.env.HOME = home;
  process.chdir(cwd);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as typeof process.stdout.write;

  try {
    await runDoctorCommand(args);
  } finally {
    process.stdout.write = originalWrite;
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  return JSON.parse(stdoutChunks.join("")) as Record<string, unknown>;
}

async function writeOldFile(path: string, content: string, daysOld = 10): Promise<void> {
  await writeFile(path, content, "utf8");
  const oldDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  await utimes(path, oldDate, oldDate);
}

test("runDoctorCommand reports launch workspace cleanup guidance without legacy runtime recommendations", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-doctor-cmd-project-"));
  const tempHome = await mkdtemp(join(os.tmpdir(), "agmo-doctor-cmd-home-"));

  await mkdir(join(tempProject, ".codex", "agents"), { recursive: true });
  await mkdir(join(tempProject, ".agmo", "state"), { recursive: true });
  await mkdir(join(tempProject, ".agmo", "cache", "launch-workspaces"), { recursive: true });

  const output = await captureDoctorCommand(["--scope", "project"], tempProject, tempHome);
  assert.deepEqual(Object.keys(output).sort(), [
    "agents_md",
    "checks",
    "command",
    "disk_usage",
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
  assert.ok(output.disk_usage && typeof output.disk_usage === "object");
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

  const output = await captureDoctorCommand(["--scope", "project"], tempProject, tempHome);
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

test("buildDoctorDiskUsage reports retention-policy candidates and deterministic largest categories", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-doctor-disk-project-"));
  const logPath = join(tempProject, ".agmo", "logs", "old.log");
  const sessionInstructionsDir = join(tempProject, ".agmo", "cache", "session-instructions", "session-1");
  const sessionInstructionsPath = join(sessionInstructionsDir, "AGENTS.md");
  const memoryPath = join(tempProject, ".agmo", "memory", "wisdom.json");
  const handoffPath = join(tempProject, ".agmo", "handoffs", "handoff-1.md");
  const statePath = join(tempProject, ".agmo", "state", "sessions", "session-1.json");

  await mkdir(join(tempProject, ".agmo", "logs"), { recursive: true });
  await mkdir(sessionInstructionsDir, { recursive: true });
  await mkdir(join(tempProject, ".agmo", "memory"), { recursive: true });
  await mkdir(join(tempProject, ".agmo", "handoffs"), { recursive: true });
  await mkdir(join(tempProject, ".agmo", "state", "sessions"), { recursive: true });
  await writeOldFile(logPath, "l".repeat(6000));
  await writeOldFile(sessionInstructionsPath, "s".repeat(5000));
  await writeOldFile(handoffPath, "AGMO\n" + "h".repeat(3000), 40);
  await writeOldFile(statePath, JSON.stringify({
    version: 1,
    session_id: "session-1",
    last_event: "Stop",
    updated_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
    active: false
  }) + "\n", 40);
  await writeFile(memoryPath, "m".repeat(4000), "utf8");
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await utimes(sessionInstructionsDir, oldDate, oldDate);

  const diskUsage = await buildDoctorDiskUsage(tempProject);
  const logCategory = diskUsage.categories.find((entry) => entry.category === "logs");
  const sessionInstructionsCategory = diskUsage.categories.find(
    (entry) => entry.category === "cache/session-instructions"
  );

  assert.equal(diskUsage.status, "ok");
  assert.equal(diskUsage.scope, "current_project");
  assert.equal(diskUsage.project_root, tempProject);
  assert.equal(diskUsage.agmo_dir, join(tempProject, ".agmo"));
  assert.equal(diskUsage.candidate_basis, "retention_policy");
  assert.ok(diskUsage.note.includes("--scope"));
  assert.ok(diskUsage.totals.bytes > 0);
  assert.ok(diskUsage.totals.entries >= 5);
  assert.ok(diskUsage.totals.safe_cleanup_candidate_bytes > 0);
  assert.ok(diskUsage.totals.safe_cleanup_candidate_entries >= 3);
  assert.equal(
    diskUsage.totals.projected_bytes_after_safe_cleanup,
    diskUsage.totals.bytes - diskUsage.totals.safe_cleanup_candidate_bytes
  );
  assert.ok((logCategory?.safe_cleanup_candidate_bytes ?? 0) > 0);
  assert.equal(logCategory?.safe_cleanup_candidate_entries, 1);
  assert.ok((sessionInstructionsCategory?.safe_cleanup_candidate_bytes ?? 0) > 0);
  assert.equal(sessionInstructionsCategory?.safe_cleanup_candidate_entries, 1);
  assert.deepEqual(
    diskUsage.largest_nonzero_categories.map((entry) => entry.category),
    ["logs", "cache/session-instructions", "memory", "handoffs", "state/sessions"]
  );
  assert.ok(diskUsage.recommendations.every((recommendation) => recommendation.severity === "info"));
  assert.deepEqual(diskUsage.recommended_actions, [
    "agmo cleanup inspect --json --verbose",
    "agmo cleanup plan --json --verbose",
    "agmo cleanup run --confirm --json",
    "agmo config cleanup set safe_auto_cleanup_on_launch true --scope project"
  ]);
});

test("runDoctorCommand user scope still reports current project disk usage", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-doctor-user-scope-project-"));
  const tempHome = await mkdtemp(join(os.tmpdir(), "agmo-doctor-user-scope-home-"));
  const realTempProject = await realpath(tempProject);
  await mkdir(join(tempProject, ".agmo", "logs"), { recursive: true });
  await writeFile(join(tempProject, ".agmo", "logs", "usage.log"), "usage\n", "utf8");

  const output = await captureDoctorCommand(["--scope", "user"], tempProject, tempHome);
  const diskUsage = output.disk_usage as {
    scope?: string;
    project_root?: string;
    agmo_dir?: string;
    candidate_basis?: string;
  };

  assert.equal(output.scope, "user");
  assert.equal(diskUsage.scope, "current_project");
  assert.equal(diskUsage.project_root, realTempProject);
  assert.equal(diskUsage.agmo_dir, join(realTempProject, ".agmo"));
  assert.equal(diskUsage.candidate_basis, "retention_policy");
});

test("buildDoctorDiskUsage returns zero ok shape when .agmo is missing", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-doctor-no-agmo-"));

  const diskUsage = await buildDoctorDiskUsage(tempProject);

  assert.equal(diskUsage.status, "ok");
  assert.equal(diskUsage.project_root, tempProject);
  assert.equal(diskUsage.agmo_dir, join(tempProject, ".agmo"));
  assert.equal(diskUsage.totals.bytes, 0);
  assert.equal(diskUsage.totals.entries, 0);
  assert.equal(diskUsage.totals.safe_cleanup_candidate_bytes, 0);
  assert.equal(diskUsage.totals.safe_cleanup_candidate_entries, 0);
  assert.equal(diskUsage.totals.projected_bytes_after_safe_cleanup, 0);
  assert.deepEqual(diskUsage.largest_nonzero_categories, []);
});

test("buildDoctorDiskUsage returns nonfatal error shape when cleanup deps fail", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-doctor-disk-failure-"));
  const deps: DoctorDiskUsageDeps = {
    async collectCleanupInventory() {
      throw new Error("inventory failed\nwith details");
    },
    async createCleanupPlan() {
      throw new Error("plan should not be reached");
    }
  };

  const diskUsage = await buildDoctorDiskUsage(tempProject, deps);

  assert.equal(diskUsage.status, "error");
  assert.equal(diskUsage.scope, "current_project");
  assert.equal(diskUsage.project_root, tempProject);
  assert.equal(diskUsage.agmo_dir, join(tempProject, ".agmo"));
  assert.equal(diskUsage.candidate_basis, "retention_policy");
  assert.deepEqual(diskUsage.error, { message: "inventory failed with details" });
  assert.equal(diskUsage.totals, null);
  assert.deepEqual(diskUsage.categories, []);
  assert.deepEqual(diskUsage.largest_nonzero_categories, []);
  assert.deepEqual(diskUsage.recommended_actions, ["agmo cleanup inspect --json --verbose"]);
});

test("runDoctorCommand ok remains based on non-disk recommendations", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-doctor-ok-project-"));
  const tempHome = await mkdtemp(join(os.tmpdir(), "agmo-doctor-ok-home-"));
  const logPath = join(tempProject, ".agmo", "logs", "old.log");
  await mkdir(join(tempProject, ".codex", "agents"), { recursive: true });
  await mkdir(join(tempProject, ".agmo", "state"), { recursive: true });
  await mkdir(join(tempProject, ".agmo", "logs"), { recursive: true });
  await writeFile(join(tempProject, ".codex", "hooks.json"), "{}", "utf8");
  await writeOldFile(logPath, "old log\n");

  const output = await captureDoctorCommand(["--scope", "project"], tempProject, tempHome);
  const nonDiskRecommendations = Object.values(output.recommendations).flat() as Array<{
    severity?: string;
  }>;

  assert.equal(
    output.ok,
    nonDiskRecommendations.every((recommendation) => recommendation.severity !== "warning")
  );
  assert.equal((output.disk_usage as { status?: string }).status, "ok");
  assert.equal(
    output.recommended_actions.some((action: string) => action.startsWith("agmo cleanup ")),
    false
  );
});
