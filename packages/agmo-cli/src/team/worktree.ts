import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, rmdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { writeJsonFile } from "../utils/fs.js";
import { sanitizeTeamName } from "./state/index.js";

export type WorktreeProvisionResult = {
  path: string;
  git_enabled: boolean;
  repo_root: string;
  base_ref: string;
  branch_name?: string;
  status: "created" | "existing";
};

export type TeamWorktreeManifestWorker = {
  worker_name: string;
  path: string;
  git_enabled: boolean;
  repo_root: string;
  base_ref: string;
  branch_name?: string;
  status: WorktreeProvisionResult["status"];
};

export type TeamWorktreeManifest = {
  version: 1;
  team_name: string;
  created_at: string;
  project_root: string;
  cwd: string;
  worktree_root: string;
  workers: TeamWorktreeManifestWorker[];
};

export type TeamWorktreeCleanupWorkerResult = {
  worker_name: string;
  path: string;
  git_enabled: boolean;
  status: "removed" | "would_remove" | "skipped" | "failed";
  reason?: string;
};

export type TeamWorktreeCleanupSummary = {
  team_name: string;
  dry_run: boolean;
  force: boolean;
  worktree_root: string;
  manifest_path: string;
  manifest_status: "valid" | "missing" | "invalid";
  status: "removed" | "would_remove" | "skipped" | "partial" | "failed";
  removed: number;
  skipped: number;
  failed: number;
  workers: TeamWorktreeCleanupWorkerResult[];
  errors: string[];
};

export function resolveTeamWorktreeRoot(
  teamName: string,
  cwd = process.cwd()
): string {
  return resolve(cwd, ".agmo", "worktrees", sanitizeTeamName(teamName));
}

export function resolveTeamWorktreeManifestPath(
  teamName: string,
  cwd = process.cwd()
): string {
  return join(resolveTeamWorktreeRoot(sanitizeTeamName(teamName), cwd), "manifest.json");
}

export function resolveWorkerWorktreePath(
  teamName: string,
  workerName: string,
  cwd = process.cwd()
): string {
  return join(resolveTeamWorktreeRoot(teamName, cwd), workerName);
}

function runGit(args: string[], cwd = process.cwd()): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function isPathWithin(parent: string, child: string): boolean {
  const pathRelative = relative(parent, child);
  return pathRelative === "" || (pathRelative.length > 0 && !pathRelative.startsWith("..") && !isAbsolute(pathRelative));
}

async function canonicalExistingPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function readTeamWorktreeManifest(
  teamName: string,
  cwd = process.cwd()
): Promise<TeamWorktreeManifest | null> {
  const manifestPath = resolveTeamWorktreeManifestPath(teamName, cwd);
  if (!existsSync(manifestPath)) {
    return null;
  }
  return JSON.parse(await readFile(manifestPath, "utf-8")) as TeamWorktreeManifest;
}

export function isGitRepository(cwd = process.cwd()): boolean {
  try {
    return runGit(["rev-parse", "--is-inside-work-tree"], cwd) === "true";
  } catch {
    return false;
  }
}

export function resolveGitRepoRoot(cwd = process.cwd()): string {
  return runGit(["rev-parse", "--show-toplevel"], cwd);
}

export function resolveGitBaseRef(cwd = process.cwd()): string {
  try {
    const branch = runGit(["branch", "--show-current"], cwd);
    if (branch) {
      return branch;
    }
  } catch {
    // fall through
  }

  return runGit(["rev-parse", "HEAD"], cwd);
}

export function hasResolvableGitHead(cwd = process.cwd()): boolean {
  try {
    runGit(["rev-parse", "--verify", "HEAD"], cwd);
    return true;
  } catch {
    return false;
  }
}

export function buildWorkerBranchName(teamName: string, workerName: string): string {
  return `agmo/${sanitizeTeamName(teamName)}/${workerName}`;
}

export async function provisionWorkerWorktree(
  teamName: string,
  workerName: string,
  cwd = process.cwd()
): Promise<WorktreeProvisionResult> {
  const worktreePath = resolveWorkerWorktreePath(teamName, workerName, cwd);
  const teamRoot = resolveTeamWorktreeRoot(teamName, cwd);
  await mkdir(teamRoot, { recursive: true });

  if (!isGitRepository(cwd)) {
    await mkdir(worktreePath, { recursive: true });
    return {
      path: worktreePath,
      git_enabled: false,
      repo_root: resolve(cwd),
      base_ref: "filesystem",
      status: "existing"
    };
  }

  const repoRoot = resolveGitRepoRoot(cwd);
  const baseRef = resolveGitBaseRef(cwd);
  if (!hasResolvableGitHead(repoRoot)) {
    await mkdir(worktreePath, { recursive: true });
    return {
      path: worktreePath,
      git_enabled: false,
      repo_root: repoRoot,
      base_ref: baseRef,
      status: "existing"
    };
  }

  const branchName = buildWorkerBranchName(teamName, workerName);
  const hasGitEntry = existsSync(join(worktreePath, ".git"));

  if (!hasGitEntry) {
    if (existsSync(worktreePath)) {
      const existingFiles = await readdir(worktreePath);
      if (existingFiles.length > 0) {
        throw new Error(
          `worktree path already exists and is not a git worktree: ${worktreePath}`
        );
      }
    }

    const localBranches = runGit(["branch", "--list", branchName], repoRoot);
    const addArgs =
      localBranches.trim().length > 0
        ? ["worktree", "add", worktreePath, branchName]
        : ["worktree", "add", "-b", branchName, worktreePath, baseRef];
    runGit(addArgs, repoRoot);
  }

  return {
    path: worktreePath,
    git_enabled: true,
    repo_root: repoRoot,
    base_ref: baseRef,
    branch_name: branchName,
    status: hasGitEntry ? "existing" : "created"
  };
}

export async function writeTeamWorktreeManifest(
  teamName: string,
  workers: TeamWorktreeManifestWorker[],
  options: {
    createdAt: string;
    cwd?: string;
  }
): Promise<TeamWorktreeManifest> {
  const cwd = options.cwd ?? process.cwd();
  const normalizedTeamName = sanitizeTeamName(teamName);
  const manifest: TeamWorktreeManifest = {
    version: 1,
    team_name: normalizedTeamName,
    created_at: options.createdAt,
    project_root: resolve(cwd),
    cwd: resolve(cwd),
    worktree_root: resolveTeamWorktreeRoot(normalizedTeamName, cwd),
    workers
  };

  await writeJsonFile(resolveTeamWorktreeManifestPath(normalizedTeamName, cwd), manifest);
  return manifest;
}

export async function cleanupTeamWorktrees(
  teamName: string,
  options: {
    dryRun?: boolean;
    force?: boolean;
    keepWorktrees?: boolean;
  } = {},
  cwd = process.cwd()
): Promise<TeamWorktreeCleanupSummary> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const expectedRoot = resolveTeamWorktreeRoot(normalizedTeamName, cwd);
  const manifestPath = resolveTeamWorktreeManifestPath(normalizedTeamName, cwd);
  const empty = (
    manifestStatus: TeamWorktreeCleanupSummary["manifest_status"],
    status: TeamWorktreeCleanupSummary["status"],
    reason: string
  ): TeamWorktreeCleanupSummary => ({
    team_name: normalizedTeamName,
    dry_run: dryRun,
    force,
    worktree_root: expectedRoot,
    manifest_path: manifestPath,
    manifest_status: manifestStatus,
    status,
    removed: 0,
    skipped: 1,
    failed: 0,
    workers: [],
    errors: reason ? [reason] : []
  });

  if (options.keepWorktrees) {
    return empty(
      existsSync(manifestPath) ? "valid" : "missing",
      "skipped",
      "worktree removal disabled by --keep-worktrees"
    );
  }

  const manifest = await readTeamWorktreeManifest(normalizedTeamName, cwd);
  if (!manifest) {
    return empty("missing", "skipped", "worktree ownership manifest not found");
  }

  const worktreesRootCanonical = await canonicalExistingPath(resolve(cwd, ".agmo", "worktrees"));
  const expectedRootCanonical = await canonicalExistingPath(expectedRoot);
  const manifestRootCanonical = await canonicalExistingPath(manifest.worktree_root);
  if (
    manifest.version !== 1 ||
    manifest.team_name !== normalizedTeamName ||
    !isPathWithin(worktreesRootCanonical, expectedRootCanonical) ||
    !isPathWithin(expectedRootCanonical, manifestRootCanonical) ||
    manifestRootCanonical !== expectedRootCanonical ||
    !Array.isArray(manifest.workers)
  ) {
    return empty("invalid", "skipped", "worktree ownership manifest failed validation");
  }

  const workers: TeamWorktreeCleanupWorkerResult[] = [];
  for (const worker of manifest.workers) {
    const workerPath = resolve(worker.path);
    const workerPathCanonical = await canonicalExistingPath(workerPath);
    if (!isPathWithin(expectedRootCanonical, workerPathCanonical)) {
      workers.push({
        worker_name: worker.worker_name,
        path: worker.path,
        git_enabled: worker.git_enabled,
        status: "skipped",
        reason: "worker path escapes team worktree root"
      });
      continue;
    }

    if (!existsSync(workerPath)) {
      workers.push({
        worker_name: worker.worker_name,
        path: worker.path,
        git_enabled: worker.git_enabled,
        status: "skipped",
        reason: "worker path does not exist"
      });
      continue;
    }

    if (dryRun) {
      workers.push({
        worker_name: worker.worker_name,
        path: worker.path,
        git_enabled: worker.git_enabled,
        status: "would_remove"
      });
      continue;
    }

    try {
      if (worker.git_enabled) {
        const repoRoot = await canonicalExistingPath(worker.repo_root);
        runGit(
          [
            "worktree",
            "remove",
            ...(force ? ["--force"] : []),
            workerPathCanonical
          ],
          repoRoot
        );
        runGit(["worktree", "prune"], repoRoot);
      } else {
        await rm(workerPathCanonical, { recursive: true, force: true });
      }
      workers.push({
        worker_name: worker.worker_name,
        path: worker.path,
        git_enabled: worker.git_enabled,
        status: "removed"
      });
    } catch (error) {
      workers.push({
        worker_name: worker.worker_name,
        path: worker.path,
        git_enabled: worker.git_enabled,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const hasUnsafeWorkerPath = workers.some(
    (worker) => worker.reason === "worker path escapes team worktree root"
  );
  if (!dryRun && !hasUnsafeWorkerPath && workers.every((worker) => worker.status !== "failed")) {
    await rm(manifestPath, { force: true });
    try {
      await rmdir(manifestRootCanonical);
    } catch {
      // Preserve non-empty roots because their extra contents are not proven worker worktrees.
    }
  }

  const removed = workers.filter((worker) => worker.status === "removed").length;
  const skipped = workers.filter((worker) => worker.status === "skipped").length;
  const failed = workers.filter((worker) => worker.status === "failed").length;
  const wouldRemove = workers.filter((worker) => worker.status === "would_remove").length;
  const status: TeamWorktreeCleanupSummary["status"] =
    failed > 0
      ? removed > 0 || skipped > 0 || wouldRemove > 0
        ? "partial"
        : "failed"
      : dryRun && wouldRemove > 0
        ? "would_remove"
        : removed > 0
          ? "removed"
          : "skipped";

  return {
    team_name: normalizedTeamName,
    dry_run: dryRun,
    force,
    worktree_root: expectedRoot,
    manifest_path: manifestPath,
    manifest_status: "valid",
    status,
    removed,
    skipped,
    failed,
    workers,
    errors: workers
      .filter((worker) => worker.status === "failed" || worker.reason)
      .map((worker) => `${worker.worker_name}: ${worker.reason ?? worker.status}`)
  };
}

export function describeWorktreePlan(teamName: string, workerCount: number): Record<string, unknown> {
  return {
    teamName,
    workerCount,
    path_pattern: `.agmo/worktrees/${teamName}/worker-N`,
    policy: [
      "git-worktree-per-worker",
      "durable directory provisioning",
      "worktree-local AGENTS bootstrap"
    ]
  };
}
