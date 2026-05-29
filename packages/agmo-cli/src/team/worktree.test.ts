import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  cleanupTeamWorktrees,
  inspectTeamWorktrees,
  resolveTeamWorktreeManifestPath,
  resolveTeamWorktreeRoot,
  writeTeamWorktreeManifest
} from "./worktree.js";
import { writeJsonFile } from "../utils/fs.js";

test("cleanupTeamWorktrees skips removal when ownership manifest is missing", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-worktree-missing-manifest-"));
  const teamName = "missing-manifest";
  const workerPath = join(resolveTeamWorktreeRoot(teamName, tempRoot), "worker-1");
  await mkdir(workerPath, { recursive: true });

  const result = await cleanupTeamWorktrees(teamName, {}, tempRoot);

  assert.equal(result.status, "skipped");
  assert.equal(result.manifest_status, "missing");
  assert.equal(existsSync(workerPath), true);
});

test("cleanupTeamWorktrees refuses manifest worker paths outside the team root", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-worktree-path-escape-"));
  const teamName = "path-escape";
  const workerPath = join(tempRoot, "outside-worker");
  await mkdir(workerPath, { recursive: true });
  await writeJsonFile(resolveTeamWorktreeManifestPath(teamName, tempRoot), {
    version: 1,
    team_name: teamName,
    created_at: new Date().toISOString(),
    project_root: tempRoot,
    cwd: tempRoot,
    worktree_root: resolveTeamWorktreeRoot(teamName, tempRoot),
    workers: [
      {
        worker_name: "worker-1",
        path: workerPath,
        git_enabled: false,
        repo_root: tempRoot,
        base_ref: "filesystem",
        status: "existing"
      }
    ]
  });

  const result = await cleanupTeamWorktrees(teamName, {}, tempRoot);

  assert.equal(result.status, "skipped");
  assert.equal(result.manifest_status, "valid");
  assert.equal(result.workers[0]?.status, "skipped");
  assert.match(result.workers[0]?.reason ?? "", /escapes/);
  assert.equal(existsSync(workerPath), true);
});

test("cleanupTeamWorktrees removes owned non-git worker directories", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-worktree-owned-remove-"));
  const teamName = "owned-remove";
  const workerPath = join(resolveTeamWorktreeRoot(teamName, tempRoot), "worker-1");
  await mkdir(workerPath, { recursive: true });
  await writeTeamWorktreeManifest(
    teamName,
    [
      {
        worker_name: "worker-1",
        path: workerPath,
        git_enabled: false,
        repo_root: resolve(tempRoot),
        base_ref: "filesystem",
        status: "existing"
      }
    ],
    {
      createdAt: new Date().toISOString(),
      cwd: tempRoot
    }
  );

  const result = await cleanupTeamWorktrees(teamName, {}, tempRoot);

  assert.equal(result.status, "removed");
  assert.equal(result.removed, 1);
  assert.equal(existsSync(resolveTeamWorktreeRoot(teamName, tempRoot)), false);
});

test("inspectTeamWorktrees reports missing manifests as manual-review leftovers", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-worktree-inspect-missing-"));
  const teamName = "missing-manifest";
  const workerPath = join(resolveTeamWorktreeRoot(teamName, tempRoot), "worker-1");
  await mkdir(workerPath, { recursive: true });

  const result = await inspectTeamWorktrees(tempRoot);

  assert.equal(result.counts.teams, 1);
  assert.equal(result.counts.missing_manifest, 1);
  assert.equal(result.counts.manual_review_required, 1);
  assert.equal(result.counts.safe_to_delete_candidates, 0);
  assert.equal(result.teams[0]?.manifest_status, "missing");
  assert.deepEqual(result.teams[0]?.reasons, [
    "missing_manifest",
    "manual_review_required"
  ]);
});

test("inspectTeamWorktrees reports invalid manifests without throwing", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-worktree-inspect-invalid-"));
  const teamName = "invalid-manifest";
  await mkdir(resolveTeamWorktreeRoot(teamName, tempRoot), { recursive: true });
  await writeFile(resolveTeamWorktreeManifestPath(teamName, tempRoot), "{not-json", "utf-8");

  const result = await inspectTeamWorktrees(tempRoot);

  assert.equal(result.counts.teams, 1);
  assert.equal(result.counts.invalid_manifest, 1);
  assert.equal(result.counts.manual_review_required, 1);
  assert.equal(result.teams[0]?.manifest_status, "invalid");
  assert.ok((result.teams[0]?.errors.length ?? 0) > 0);
});

test("inspectTeamWorktrees reports manifest-owned clean filesystem workers as cleanup candidates", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-worktree-inspect-clean-"));
  const teamName = "owned-clean";
  const workerPath = join(resolveTeamWorktreeRoot(teamName, tempRoot), "worker-1");
  await mkdir(workerPath, { recursive: true });
  await writeTeamWorktreeManifest(
    teamName,
    [
      {
        worker_name: "worker-1",
        path: workerPath,
        git_enabled: false,
        repo_root: resolve(tempRoot),
        base_ref: "filesystem",
        status: "existing"
      }
    ],
    {
      createdAt: new Date().toISOString(),
      cwd: tempRoot
    }
  );

  const result = await inspectTeamWorktrees(tempRoot);

  assert.equal(result.counts.manifest_owned, 1);
  assert.equal(result.counts.clean_worker, 1);
  assert.equal(result.counts.safe_to_delete_candidates, 1);
  assert.equal(result.teams[0]?.safe_to_delete_candidate, true);
  assert.deepEqual(result.teams[0]?.reasons, ["manifest_owned", "clean_worker"]);
  assert.deepEqual(result.teams[0]?.workers[0]?.reasons, ["clean_worker"]);
});

test("inspectTeamWorktrees reports missing manifest-owned worker paths", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-worktree-inspect-missing-worker-"));
  const teamName = "missing-worker";
  const workerPath = join(resolveTeamWorktreeRoot(teamName, tempRoot), "worker-1");
  await mkdir(resolveTeamWorktreeRoot(teamName, tempRoot), { recursive: true });
  await writeTeamWorktreeManifest(
    teamName,
    [
      {
        worker_name: "worker-1",
        path: workerPath,
        git_enabled: false,
        repo_root: resolve(tempRoot),
        base_ref: "filesystem",
        status: "existing"
      }
    ],
    {
      createdAt: new Date().toISOString(),
      cwd: tempRoot
    }
  );

  const result = await inspectTeamWorktrees(tempRoot);

  assert.equal(result.counts.manifest_owned, 1);
  assert.equal(result.counts.worker_path_missing, 1);
  assert.equal(result.counts.safe_to_delete_candidates, 0);
  assert.equal(result.teams[0]?.workers[0]?.exists, false);
  assert.deepEqual(result.teams[0]?.reasons, ["manifest_owned", "worker_path_missing"]);
  assert.deepEqual(result.teams[0]?.workers[0]?.reasons, ["worker_path_missing"]);
});

test("inspectTeamWorktrees reports dirty git workers with registered worktree evidence", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-worktree-inspect-dirty-"));
  const teamName = "dirty-git";
  const workerPath = join(resolveTeamWorktreeRoot(teamName, tempRoot), "worker-1");
  await mkdir(workerPath, { recursive: true });
  execFileSync("git", ["init"], { cwd: workerPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "agmo@example.test"], {
    cwd: workerPath,
    stdio: "ignore"
  });
  execFileSync("git", ["config", "user.name", "Agmo Test"], {
    cwd: workerPath,
    stdio: "ignore"
  });
  await writeFile(join(workerPath, "tracked.txt"), "tracked\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: workerPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workerPath, stdio: "ignore" });
  await writeFile(join(workerPath, "untracked.txt"), "dirty\n");
  await writeTeamWorktreeManifest(
    teamName,
    [
      {
        worker_name: "worker-1",
        path: workerPath,
        git_enabled: true,
        repo_root: workerPath,
        base_ref: "main",
        status: "existing"
      }
    ],
    {
      createdAt: new Date().toISOString(),
      cwd: tempRoot
    }
  );

  const result = await inspectTeamWorktrees(tempRoot);

  assert.equal(result.counts.dirty_worker, 1);
  assert.equal(result.counts.git_worktree_registered, 1);
  assert.equal(result.counts.manual_review_required, 1);
  assert.equal(result.counts.safe_to_delete_candidates, 0);
  assert.equal(result.teams[0]?.safe_to_delete_candidate, false);
  assert.deepEqual(result.teams[0]?.reasons, [
    "manifest_owned",
    "git_worktree_registered",
    "dirty_worker",
    "manual_review_required"
  ]);
  assert.deepEqual(result.teams[0]?.workers[0]?.reasons, [
    "git_worktree_registered",
    "dirty_worker",
    "manual_review_required"
  ]);
});

test("inspectTeamWorktrees rejects plain project subdirectories marked as git workers", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-worktree-inspect-plain-git-"));
  execFileSync("git", ["init"], { cwd: tempRoot, stdio: "ignore" });
  const teamName = "plain-git-worker";
  const workerPath = join(resolveTeamWorktreeRoot(teamName, tempRoot), "worker-1");
  await mkdir(workerPath, { recursive: true });
  await writeTeamWorktreeManifest(
    teamName,
    [
      {
        worker_name: "worker-1",
        path: workerPath,
        git_enabled: true,
        repo_root: tempRoot,
        base_ref: "main",
        status: "existing"
      }
    ],
    {
      createdAt: new Date().toISOString(),
      cwd: tempRoot
    }
  );

  const result = await inspectTeamWorktrees(tempRoot);

  assert.equal(result.counts.worker_path_not_git_worktree, 1);
  assert.equal(result.counts.manual_review_required, 1);
  assert.equal(result.counts.clean_worker, 0);
  assert.equal(result.counts.safe_to_delete_candidates, 0);
  assert.equal(result.teams[0]?.workers[0]?.is_git_worktree, false);
  assert.equal(result.teams[0]?.workers[0]?.git_worktree_registered, false);
  assert.deepEqual(result.teams[0]?.workers[0]?.reasons, [
    "worker_path_not_git_worktree",
    "manual_review_required"
  ]);
});

test("inspectTeamWorktrees ignores worker bootstrap files when checking git dirtiness", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-worktree-inspect-bootstrap-clean-"));
  const teamName = "bootstrap-clean-git";
  const workerPath = join(resolveTeamWorktreeRoot(teamName, tempRoot), "worker-1");
  await mkdir(workerPath, { recursive: true });
  execFileSync("git", ["init"], { cwd: workerPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "agmo@example.test"], {
    cwd: workerPath,
    stdio: "ignore"
  });
  execFileSync("git", ["config", "user.name", "Agmo Test"], {
    cwd: workerPath,
    stdio: "ignore"
  });
  await writeFile(join(workerPath, "tracked.txt"), "tracked\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: workerPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workerPath, stdio: "ignore" });
  await mkdir(join(workerPath, ".codex"), { recursive: true });
  await mkdir(join(workerPath, ".agmo"), { recursive: true });
  await writeFile(join(workerPath, "AGENTS.md"), "worker bootstrap\n");
  await writeFile(join(workerPath, ".codex", "hooks.json"), "{}\n");
  await writeFile(join(workerPath, ".agmo", "state.json"), "{}\n");
  await writeTeamWorktreeManifest(
    teamName,
    [
      {
        worker_name: "worker-1",
        path: workerPath,
        git_enabled: true,
        repo_root: workerPath,
        base_ref: "main",
        status: "existing"
      }
    ],
    {
      createdAt: new Date().toISOString(),
      cwd: tempRoot
    }
  );

  const result = await inspectTeamWorktrees(tempRoot);

  assert.equal(result.counts.dirty_worker, 0);
  assert.equal(result.counts.manual_review_required, 0);
  assert.equal(result.counts.clean_worker, 1);
  assert.equal(result.counts.safe_to_delete_candidates, 1);
  assert.deepEqual(result.teams[0]?.workers[0]?.reasons, [
    "git_worktree_registered",
    "clean_worker"
  ]);
});
