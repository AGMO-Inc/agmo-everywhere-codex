import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sanitizeTeamName } from "./state/index.js";

export type WorktreeProvisionResult = {
  path: string;
  git_enabled: boolean;
  repo_root: string;
  base_ref: string;
  branch_name?: string;
  status: "created" | "existing";
};

export function resolveTeamWorktreeRoot(
  teamName: string,
  cwd = process.cwd()
): string {
  return resolve(cwd, ".agmo", "worktrees", teamName);
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
