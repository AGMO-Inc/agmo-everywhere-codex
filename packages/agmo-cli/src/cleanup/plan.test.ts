import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { CLEANUP_CAP_REASONS, createCleanupPlan } from "./plan.js";

const DAY_MS = 24 * 60 * 60 * 1000;

async function writeConfig(projectRoot: string, cleanup: Record<string, unknown>): Promise<void> {
  await mkdir(join(projectRoot, ".agmo"), { recursive: true });
  await writeFile(join(projectRoot, ".agmo", "config.json"), `${JSON.stringify({ cleanup }, null, 2)}\n`);
}

async function writeState(projectRoot: string, category: "sessions" | "workflows", sessionId: string, ageDays = 0): Promise<string> {
  const path = join(projectRoot, ".agmo", "state", category, `${sessionId}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        version: 1,
        session_id: sessionId,
        active: false,
        last_event: "Stop",
        updated_at: new Date(Date.now() - ageDays * DAY_MS).toISOString()
      },
      null,
      2
    )}\n`
  );
  const date = new Date(Date.now() - ageDays * DAY_MS);
  await utimes(path, date, date);
  return path;
}

async function writeLaunchWorkspace(projectRoot: string, sessionId: string, ageDays = 0): Promise<void> {
  const workspaceDir = join(projectRoot, ".agmo", "cache", "launch-workspaces", sessionId);
  const workspaceRoot = join(workspaceDir, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  execFileSync("git", ["init"], { cwd: workspaceRoot, stdio: "ignore" });
  await writeFile(
    join(workspaceDir, "metadata.json"),
    `${JSON.stringify(
      {
        session_id: sessionId,
        project_root: projectRoot,
        workspace_root: workspaceRoot,
        composed_agents_path: join(projectRoot, ".agmo", "cache", "session-instructions", sessionId, "AGENTS.md"),
        created_at: new Date(Date.now() - ageDays * DAY_MS).toISOString(),
        active: false
      },
      null,
      2
    )}\n`
  );
}

test("configured cleanup cap value 0 disables configured cap phases", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agmo-plan-zero-caps-"));
  await writeConfig(projectRoot, {
    cache_ttl_days: 99,
    launch_workspace_ttl_hours: 99 * 24,
    state_ttl_days: 99,
    workflow_state_ttl_days: 99,
    max_project_agmo_bytes: 0,
    max_launch_workspace_bytes: 0,
    max_state_files: 0
  });
  await writeLaunchWorkspace(projectRoot, "launch-a");
  await writeState(projectRoot, "sessions", "state-a");
  await mkdir(join(projectRoot, ".agmo", "logs"), { recursive: true });
  await writeFile(join(projectRoot, ".agmo", "logs", "new.log"), "new log\n");

  const plan = await createCleanupPlan(projectRoot);

  assert.equal(plan.would_delete.length, 0);
  assert.equal(plan.effective_caps.max_project_agmo_bytes.effective, null);
  assert.equal(plan.effective_caps.max_launch_workspace_bytes.effective, null);
  assert.equal(plan.effective_caps.max_state_files.effective, null);
  assert.equal(plan.pressure.project_bytes.target, null);
});

test("explicit maxBytes 0 is strict and overrides only the project cap", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agmo-plan-max-zero-"));
  await writeConfig(projectRoot, {
    cache_ttl_days: 99,
    max_project_agmo_bytes: 0,
    max_launch_workspace_bytes: 0,
    max_state_files: 0
  });
  await mkdir(join(projectRoot, ".agmo", "logs"), { recursive: true });
  await mkdir(join(projectRoot, ".agmo", "memory"), { recursive: true });
  await writeFile(join(projectRoot, ".agmo", "logs", "new.log"), "eligible\n");
  await writeFile(join(projectRoot, ".agmo", "memory", "keep.json"), "protected\n");

  const plan = await createCleanupPlan(projectRoot, { maxBytes: 0 });

  assert.equal(plan.options.max_bytes, 0);
  assert.equal(plan.effective_caps.max_project_agmo_bytes.explicit_override, 0);
  assert.equal(plan.effective_caps.max_project_agmo_bytes.effective, 0);
  assert.ok(plan.would_delete.some((entry) => entry.reason === CLEANUP_CAP_REASONS.projectBytes));
  assert.equal(plan.pressure.project_bytes.reachable, false);
});

test("launch workspace byte cap selects clean inactive retained workspaces oldest first", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agmo-plan-launch-cap-"));
  await writeConfig(projectRoot, {
    launch_workspace_ttl_hours: 99 * 24,
    max_launch_workspace_bytes: 1,
    max_project_agmo_bytes: 0,
    max_state_files: 0
  });
  await writeLaunchWorkspace(projectRoot, "launch-old", 2);
  await writeLaunchWorkspace(projectRoot, "launch-new", 1);

  const plan = await createCleanupPlan(projectRoot);

  assert.equal(plan.pressure.launch_workspace_bytes.target, 1);
  assert.ok(plan.pressure.launch_workspace_bytes.selected_entries >= 1);
  assert.equal(plan.would_delete[0]?.relative_path, ".agmo/cache/launch-workspaces/launch-old");
  assert.equal(plan.would_delete[0]?.reason, CLEANUP_CAP_REASONS.launchWorkspaceBytes);
});

test("state file count cap pairs session and workflow records across the boundary", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agmo-plan-state-cap-"));
  await writeConfig(projectRoot, {
    state_ttl_days: 99,
    workflow_state_ttl_days: 99,
    max_state_files: 1,
    max_launch_workspace_bytes: 0,
    max_project_agmo_bytes: 0
  });
  await writeState(projectRoot, "sessions", "paired");
  await writeState(projectRoot, "workflows", "paired");

  const plan = await createCleanupPlan(projectRoot);

  assert.equal(plan.pressure.state_files.target, 1);
  assert.equal(plan.pressure.state_files.pairs_selected, 1);
  assert.equal(plan.pressure.state_files.selected_entries, 2);
  assert.equal(plan.pressure.state_files.after_count, 0);
  assert.deepEqual(
    plan.would_delete.map((entry) => ({ relative_path: entry.relative_path, reason: entry.reason })),
    [
      { relative_path: ".agmo/state/sessions/paired.json", reason: CLEANUP_CAP_REASONS.stateFileCount },
      { relative_path: ".agmo/state/workflows/paired.json", reason: CLEANUP_CAP_REASONS.stateFileCount }
    ]
  );
});
