import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  cleanupTeamWorktrees,
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
