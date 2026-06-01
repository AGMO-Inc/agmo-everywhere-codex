import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  archiveTeamWorktree,
  cleanupTeamWorktrees,
  discardTeamWorktree,
  inspectTeamWorktrees,
  promoteTeamWorktree,
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
  assert.equal(result.teams[0]?.classification, "cleanup_candidate");
  assert.deepEqual(result.teams[0]?.recommended_actions, [
    `team delete ${teamName} --dry-run --remove-worktrees`
  ]);
  assert.deepEqual(result.teams[0]?.reasons, ["manifest_owned", "clean_worker"]);
  assert.equal(result.teams[0]?.workers[0]?.classification, "cleanup_candidate");
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
  assert.equal(result.teams[0]?.classification, "already_missing");
  assert.equal(result.teams[0]?.workers[0]?.exists, false);
  assert.equal(result.teams[0]?.workers[0]?.classification, "already_missing");
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
  assert.equal(result.teams[0]?.classification, "manual_review_required");
  assert.ok(
    result.teams[0]?.recommended_actions.includes(
      `team worktree inspect ${teamName} worker-1`
    )
  );
  assert.deepEqual(result.teams[0]?.reasons, [
    "manifest_owned",
    "git_worktree_registered",
    "dirty_worker",
    "manual_review_required"
  ]);
  assert.equal(result.teams[0]?.workers[0]?.classification, "manual_review_required");
  assert.ok(result.teams[0]?.workers[0]?.git_summary);
  assert.equal(result.teams[0]?.workers[0]?.git_summary?.status_porcelain.count, 1);
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

test("inspectTeamWorktrees rejects symlink worker paths that escape the team root", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-worktree-inspect-symlink-escape-"));
  const teamName = "symlink-escape";
  const outsidePath = join(tempRoot, "outside-worker");
  const workerPath = join(resolveTeamWorktreeRoot(teamName, tempRoot), "worker-1");
  await mkdir(outsidePath, { recursive: true });
  await mkdir(resolveTeamWorktreeRoot(teamName, tempRoot), { recursive: true });
  await symlink(outsidePath, workerPath, "dir");
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

  const inspected = await inspectTeamWorktrees(tempRoot);
  const discarded = await discardTeamWorktree(
    teamName,
    { workerName: "worker-1", force: true },
    tempRoot
  );

  assert.equal(inspected.counts.manual_review_required, 1);
  assert.equal(inspected.teams[0]?.workers[0]?.classification, "manual_review_required");
  assert.deepEqual(inspected.teams[0]?.workers[0]?.reasons, ["manual_review_required"]);
  assert.equal(discarded.status, "refused");
  assert.equal(discarded.workers[0]?.reason, "worker path escapes team worktree root");
  assert.equal(existsSync(outsidePath), true);
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

test("archiveTeamWorktree writes summary and git evidence without removing worker", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-worktree-archive-"));
  execFileSync("git", ["init"], { cwd: tempRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "agmo@example.test"], { cwd: tempRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Agmo Test"], { cwd: tempRoot, stdio: "ignore" });
  await writeFile(join(tempRoot, "tracked.txt"), "tracked\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: tempRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: tempRoot, stdio: "ignore" });

  const teamName = "archive-git";
  const workerPath = join(resolveTeamWorktreeRoot(teamName, tempRoot), "worker-1");
  execFileSync("git", ["worktree", "add", "-b", `agmo/${teamName}/worker-1`, workerPath, "HEAD"], {
    cwd: tempRoot,
    stdio: "ignore"
  });
  await writeFile(join(workerPath, "tracked.txt"), "changed\n");
  await mkdir(join(workerPath, "notes"), { recursive: true });
  await writeFile(join(workerPath, "notes", "untracked.md"), "untracked evidence\n");
  await writeTeamWorktreeManifest(
    teamName,
    [
      {
        worker_name: "worker-1",
        path: workerPath,
        git_enabled: true,
        repo_root: tempRoot,
        base_ref: "HEAD",
        branch_name: `agmo/${teamName}/worker-1`,
        status: "created"
      }
    ],
    { createdAt: new Date().toISOString(), cwd: tempRoot }
  );

  const result = await archiveTeamWorktree(teamName, { workerName: "worker-1" }, tempRoot);

  assert.equal(result.status, "archived");
  assert.equal(result.archived, 1);
  assert.equal(existsSync(workerPath), true);
  const worker = result.workers[0];
  assert.equal(worker?.classification, "manual_review_required");
  assert.ok(worker?.archive_paths.summary_json);
  assert.ok(worker?.archive_paths.status_txt);
  assert.ok(worker?.archive_paths.diff_patch);
  assert.ok(worker?.archive_paths.untracked_dir);
  const summary = JSON.parse(await readFile(worker.archive_paths.summary_json, "utf-8")) as {
    classification?: string;
    git_summary?: { status_porcelain?: { count?: number } };
    untracked_files?: Array<{ path?: string; archive_path?: string }>;
  };
  assert.equal(summary.classification, "manual_review_required");
  assert.equal(summary.git_summary?.status_porcelain?.count, 2);
  assert.deepEqual(summary.untracked_files?.map((file) => file.path), ["notes/untracked.md"]);
  assert.equal(
    await readFile(join(worker.archive_paths.untracked_dir, "notes", "untracked.md"), "utf-8"),
    "untracked evidence\n"
  );
  assert.match(await readFile(worker.archive_paths.diff_patch, "utf-8"), /changed/);
});

test("archiveTeamWorktree refuses untracked symlinks instead of dereferencing them", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-worktree-archive-symlink-"));
  execFileSync("git", ["init"], { cwd: tempRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "agmo@example.test"], { cwd: tempRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Agmo Test"], { cwd: tempRoot, stdio: "ignore" });
  await writeFile(join(tempRoot, "tracked.txt"), "tracked\n");
  await writeFile(join(tempRoot, "outside-secret.txt"), "outside secret\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: tempRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: tempRoot, stdio: "ignore" });

  const teamName = "archive-symlink";
  const workerPath = join(resolveTeamWorktreeRoot(teamName, tempRoot), "worker-1");
  execFileSync("git", ["worktree", "add", "-b", `agmo/${teamName}/worker-1`, workerPath, "HEAD"], {
    cwd: tempRoot,
    stdio: "ignore"
  });
  await symlink(join(tempRoot, "outside-secret.txt"), join(workerPath, "leak.txt"));
  await writeTeamWorktreeManifest(
    teamName,
    [
      {
        worker_name: "worker-1",
        path: workerPath,
        git_enabled: true,
        repo_root: tempRoot,
        base_ref: "HEAD",
        branch_name: `agmo/${teamName}/worker-1`,
        status: "created"
      }
    ],
    { createdAt: new Date().toISOString(), cwd: tempRoot }
  );

  const result = await archiveTeamWorktree(teamName, { workerName: "worker-1" }, tempRoot);

  assert.equal(result.status, "failed");
  assert.equal(result.workers[0]?.status, "failed");
  assert.match(result.workers[0]?.reason ?? "", /untracked path is a symlink/);
  assert.equal(result.workers[0]?.untracked_files, undefined);
});

test("discardTeamWorktree defaults to dry-run and refuses dirty workers without force", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-worktree-discard-dirty-"));
  execFileSync("git", ["init"], { cwd: tempRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "agmo@example.test"], { cwd: tempRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Agmo Test"], { cwd: tempRoot, stdio: "ignore" });
  await writeFile(join(tempRoot, "tracked.txt"), "tracked\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: tempRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: tempRoot, stdio: "ignore" });

  const teamName = "discard-dirty";
  const workerPath = join(resolveTeamWorktreeRoot(teamName, tempRoot), "worker-1");
  execFileSync("git", ["worktree", "add", "-b", `agmo/${teamName}/worker-1`, workerPath, "HEAD"], {
    cwd: tempRoot,
    stdio: "ignore"
  });
  await writeFile(join(workerPath, "tracked.txt"), "changed\n");
  await writeFile(join(workerPath, "untracked.txt"), "preserve me\n");
  await writeTeamWorktreeManifest(
    teamName,
    [
      {
        worker_name: "worker-1",
        path: workerPath,
        git_enabled: true,
        repo_root: tempRoot,
        base_ref: "HEAD",
        branch_name: `agmo/${teamName}/worker-1`,
        status: "created"
      }
    ],
    { createdAt: new Date().toISOString(), cwd: tempRoot }
  );

  const result = await discardTeamWorktree(teamName, { workerName: "worker-1" }, tempRoot);

  assert.equal(result.dry_run, true);
  assert.equal(result.status, "refused");
  assert.equal(result.workers[0]?.status, "refused");
  assert.match(result.workers[0]?.reason ?? "", /requires --force/);
  assert.equal(existsSync(workerPath), true);
});

test("discardTeamWorktree force archive removes dirty git workers after evidence is written", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-worktree-discard-force-"));
  execFileSync("git", ["init"], { cwd: tempRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "agmo@example.test"], { cwd: tempRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Agmo Test"], { cwd: tempRoot, stdio: "ignore" });
  await writeFile(join(tempRoot, "tracked.txt"), "tracked\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: tempRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: tempRoot, stdio: "ignore" });

  const teamName = "discard-force";
  const workerPath = join(resolveTeamWorktreeRoot(teamName, tempRoot), "worker-1");
  execFileSync("git", ["worktree", "add", "-b", `agmo/${teamName}/worker-1`, workerPath, "HEAD"], {
    cwd: tempRoot,
    stdio: "ignore"
  });
  await writeFile(join(workerPath, "tracked.txt"), "changed\n");
  await writeFile(join(workerPath, "untracked.txt"), "preserve me\n");
  await writeTeamWorktreeManifest(
    teamName,
    [
      {
        worker_name: "worker-1",
        path: workerPath,
        git_enabled: true,
        repo_root: tempRoot,
        base_ref: "HEAD",
        branch_name: `agmo/${teamName}/worker-1`,
        status: "created"
      }
    ],
    { createdAt: new Date().toISOString(), cwd: tempRoot }
  );

  const result = await discardTeamWorktree(
    teamName,
    { workerName: "worker-1", force: true, archive: true },
    tempRoot
  );

  assert.equal(result.status, "removed");
  assert.equal(result.workers[0]?.status, "removed");
  assert.equal(result.workers[0]?.archive?.status, "archived");
  const untrackedDir = result.workers[0]?.archive?.archive_paths.untracked_dir;
  assert.ok(untrackedDir);
  assert.equal(await readFile(join(untrackedDir, "untracked.txt"), "utf-8"), "preserve me\n");
  assert.equal(existsSync(workerPath), false);
});

test("promoteTeamWorktree creates a preservation branch for clean git workers only", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-worktree-promote-"));
  execFileSync("git", ["init"], { cwd: tempRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "agmo@example.test"], { cwd: tempRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Agmo Test"], { cwd: tempRoot, stdio: "ignore" });
  await writeFile(join(tempRoot, "tracked.txt"), "tracked\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: tempRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: tempRoot, stdio: "ignore" });

  const teamName = "promote-clean";
  const workerPath = join(resolveTeamWorktreeRoot(teamName, tempRoot), "worker-1");
  execFileSync("git", ["worktree", "add", "-b", `agmo/${teamName}/worker-1`, workerPath, "HEAD"], {
    cwd: tempRoot,
    stdio: "ignore"
  });
  await writeTeamWorktreeManifest(
    teamName,
    [
      {
        worker_name: "worker-1",
        path: workerPath,
        git_enabled: true,
        repo_root: tempRoot,
        base_ref: "HEAD",
        branch_name: `agmo/${teamName}/worker-1`,
        status: "created"
      }
    ],
    { createdAt: new Date().toISOString(), cwd: tempRoot }
  );

  const dryRun = await promoteTeamWorktree(
    teamName,
    "worker-1",
    { branchName: "preserve/worker-1", dryRun: true },
    tempRoot
  );
  assert.equal(dryRun.status, "would_promote");
  assert.equal(execFileSync("git", ["branch", "--list", "preserve/worker-1"], { cwd: tempRoot, encoding: "utf-8" }), "");

  const promoted = await promoteTeamWorktree(
    teamName,
    "worker-1",
    { branchName: "preserve/worker-1" },
    tempRoot
  );
  assert.equal(promoted.status, "promoted");
  assert.match(execFileSync("git", ["branch", "--list", "preserve/worker-1"], { cwd: tempRoot, encoding: "utf-8" }), /preserve\/worker-1/);
});
