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

export type TeamWorktreeDiagnosticReason =
  | "manifest_owned"
  | "missing_manifest"
  | "invalid_manifest"
  | "worker_path_missing"
  | "worker_path_not_git_worktree"
  | "git_worktree_registered"
  | "dirty_worker"
  | "clean_worker"
  | "manual_review_required";

export type TeamWorktreeDiagnosticWorker = {
  worker_name: string;
  path: string;
  git_enabled: boolean;
  exists: boolean;
  is_git_worktree: boolean;
  git_worktree_registered: boolean;
  dirty: boolean;
  reasons: TeamWorktreeDiagnosticReason[];
};

export type TeamWorktreeDiagnosticEntry = {
  team_name: string;
  worktree_root: string;
  manifest_path: string;
  manifest_status: "valid" | "missing" | "invalid";
  reasons: TeamWorktreeDiagnosticReason[];
  safe_to_delete_candidate: boolean;
  workers: TeamWorktreeDiagnosticWorker[];
  errors: string[];
};

export type TeamWorktreeDiagnosticsSummary = {
  worktrees_root: string;
  counts: {
    teams: number;
    manifest_owned: number;
    missing_manifest: number;
    invalid_manifest: number;
    worker_path_missing: number;
    worker_path_not_git_worktree: number;
    git_worktree_registered: number;
    dirty_worker: number;
    clean_worker: number;
    manual_review_required: number;
    safe_to_delete_candidates: number;
  };
  teams: TeamWorktreeDiagnosticEntry[];
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

function tryRunGit(args: string[], cwd = process.cwd()): string | null {
  try {
    return runGit(args, cwd);
  } catch {
    return null;
  }
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

function incrementDiagnosticCount(
  counts: TeamWorktreeDiagnosticsSummary["counts"],
  reason: TeamWorktreeDiagnosticReason
): void {
  if (reason === "manifest_owned") {
    counts.manifest_owned += 1;
  } else if (reason === "missing_manifest") {
    counts.missing_manifest += 1;
  } else if (reason === "invalid_manifest") {
    counts.invalid_manifest += 1;
  } else if (reason === "worker_path_missing") {
    counts.worker_path_missing += 1;
  } else if (reason === "worker_path_not_git_worktree") {
    counts.worker_path_not_git_worktree += 1;
  } else if (reason === "git_worktree_registered") {
    counts.git_worktree_registered += 1;
  } else if (reason === "dirty_worker") {
    counts.dirty_worker += 1;
  } else if (reason === "clean_worker") {
    counts.clean_worker += 1;
  } else if (reason === "manual_review_required") {
    counts.manual_review_required += 1;
  }
}

function addDiagnosticReason(
  reasons: TeamWorktreeDiagnosticReason[],
  reason: TeamWorktreeDiagnosticReason
): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function isGitWorktreePath(path: string): boolean {
  return existsSync(join(path, ".git")) && tryRunGit(["rev-parse", "--show-toplevel"], path) === path;
}

function listRegisteredGitWorktreePaths(repoRoot: string): Set<string> {
  const output = tryRunGit(["worktree", "list", "--porcelain"], repoRoot);
  if (output === null) {
    return new Set();
  }

  return new Set(
    output
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => resolve(line.slice("worktree ".length)))
  );
}

function gitStatusPorcelainIgnoringRuntimeFiles(cwd: string): string {
  return (
    tryRunGit(
      [
        "status",
        "--porcelain",
        "--",
        ".",
        ":(exclude)AGENTS.md",
        ":(exclude).codex",
        ":(exclude).agmo"
      ],
      cwd
    ) ?? ""
  );
}

function hasValidManifestShape(manifest: TeamWorktreeManifest): boolean {
  return (
    manifest.version === 1 &&
    typeof manifest.team_name === "string" &&
    typeof manifest.worktree_root === "string" &&
    Array.isArray(manifest.workers) &&
    manifest.workers.every(
      (worker) =>
        typeof worker.worker_name === "string" &&
        typeof worker.path === "string" &&
        typeof worker.git_enabled === "boolean" &&
        typeof worker.repo_root === "string"
    )
  );
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

export async function inspectTeamWorktrees(
  cwd = process.cwd()
): Promise<TeamWorktreeDiagnosticsSummary> {
  const worktreesRoot = resolve(cwd, ".agmo", "worktrees");
  const counts: TeamWorktreeDiagnosticsSummary["counts"] = {
    teams: 0,
    manifest_owned: 0,
    missing_manifest: 0,
    invalid_manifest: 0,
    worker_path_missing: 0,
    worker_path_not_git_worktree: 0,
    git_worktree_registered: 0,
    dirty_worker: 0,
    clean_worker: 0,
    manual_review_required: 0,
    safe_to_delete_candidates: 0
  };

  if (!existsSync(worktreesRoot)) {
    return {
      worktrees_root: worktreesRoot,
      counts,
      teams: []
    };
  }

  const worktreesRootCanonical = await canonicalExistingPath(worktreesRoot);
  const teamDirs = (await readdir(worktreesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const teams: TeamWorktreeDiagnosticEntry[] = [];
  for (const teamDir of teamDirs) {
    const teamName = sanitizeTeamName(teamDir);
    const expectedRoot = resolveTeamWorktreeRoot(teamName, cwd);
    const manifestPath = resolveTeamWorktreeManifestPath(teamName, cwd);
    const teamReasons: TeamWorktreeDiagnosticReason[] = [];
    const errors: string[] = [];
    const workers: TeamWorktreeDiagnosticWorker[] = [];
    let manifestStatus: TeamWorktreeDiagnosticEntry["manifest_status"] = "missing";
    let manifest: TeamWorktreeManifest | null = null;

    if (!existsSync(manifestPath)) {
      addDiagnosticReason(teamReasons, "missing_manifest");
      addDiagnosticReason(teamReasons, "manual_review_required");
    } else {
      try {
        manifest = await readTeamWorktreeManifest(teamName, cwd);
      } catch (error) {
        manifestStatus = "invalid";
        addDiagnosticReason(teamReasons, "invalid_manifest");
        addDiagnosticReason(teamReasons, "manual_review_required");
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (manifest) {
      const expectedRootCanonical = await canonicalExistingPath(expectedRoot);
      const manifestRootCanonical = hasValidManifestShape(manifest)
        ? await canonicalExistingPath(manifest.worktree_root)
        : null;
      if (
        !hasValidManifestShape(manifest) ||
        manifest.version !== 1 ||
        manifest.team_name !== teamName ||
        !isPathWithin(worktreesRootCanonical, expectedRootCanonical) ||
        manifestRootCanonical === null ||
        !isPathWithin(expectedRootCanonical, manifestRootCanonical) ||
        manifestRootCanonical !== expectedRootCanonical ||
        !Array.isArray(manifest.workers)
      ) {
        manifestStatus = "invalid";
        addDiagnosticReason(teamReasons, "invalid_manifest");
        addDiagnosticReason(teamReasons, "manual_review_required");
      } else {
        manifestStatus = "valid";
        addDiagnosticReason(teamReasons, "manifest_owned");

        for (const worker of manifest.workers) {
          const workerPath = resolve(worker.path);
          const workerPathCanonical = await canonicalExistingPath(workerPath);
          const workerReasons: TeamWorktreeDiagnosticReason[] = [];
          const exists = existsSync(workerPath);
          const workerPathWithinRoot =
            isPathWithin(expectedRootCanonical, workerPathCanonical) ||
            isPathWithin(expectedRoot, workerPath);
          let isGitWorktree = false;
          let gitWorktreeRegistered = false;
          let dirty = false;

          if (!workerPathWithinRoot) {
            addDiagnosticReason(workerReasons, "manual_review_required");
            addDiagnosticReason(teamReasons, "manual_review_required");
            errors.push(`${worker.worker_name}: worker path escapes team worktree root`);
          } else if (!exists) {
            addDiagnosticReason(workerReasons, "worker_path_missing");
            addDiagnosticReason(teamReasons, "worker_path_missing");
          } else {
            isGitWorktree = isGitWorktreePath(workerPathCanonical);
            if (worker.git_enabled && !isGitWorktree) {
              addDiagnosticReason(workerReasons, "worker_path_not_git_worktree");
              addDiagnosticReason(workerReasons, "manual_review_required");
              addDiagnosticReason(teamReasons, "worker_path_not_git_worktree");
              addDiagnosticReason(teamReasons, "manual_review_required");
            }

            if (isGitWorktree) {
              const registeredPaths = listRegisteredGitWorktreePaths(worker.repo_root);
              gitWorktreeRegistered = registeredPaths.has(workerPathCanonical);
              if (gitWorktreeRegistered) {
                addDiagnosticReason(workerReasons, "git_worktree_registered");
                addDiagnosticReason(teamReasons, "git_worktree_registered");
              }

              dirty = gitStatusPorcelainIgnoringRuntimeFiles(workerPathCanonical).length > 0;
              if (dirty) {
                addDiagnosticReason(workerReasons, "dirty_worker");
                addDiagnosticReason(workerReasons, "manual_review_required");
                addDiagnosticReason(teamReasons, "dirty_worker");
                addDiagnosticReason(teamReasons, "manual_review_required");
              } else {
                addDiagnosticReason(workerReasons, "clean_worker");
                addDiagnosticReason(teamReasons, "clean_worker");
              }
            } else if (!worker.git_enabled) {
              addDiagnosticReason(workerReasons, "clean_worker");
              addDiagnosticReason(teamReasons, "clean_worker");
            }
          }

          workers.push({
            worker_name: worker.worker_name,
            path: worker.path,
            git_enabled: worker.git_enabled,
            exists,
            is_git_worktree: isGitWorktree,
            git_worktree_registered: gitWorktreeRegistered,
            dirty,
            reasons: workerReasons
          });
        }
      }
    }

    const safeToDeleteCandidate =
      manifestStatus === "valid" &&
      workers.length > 0 &&
      workers.every(
        (worker) =>
          worker.exists &&
          worker.reasons.includes("clean_worker") &&
          (!worker.git_enabled || worker.git_worktree_registered) &&
          !worker.reasons.includes("manual_review_required")
      );
    if (safeToDeleteCandidate) {
      counts.safe_to_delete_candidates += 1;
    }

    const entry: TeamWorktreeDiagnosticEntry = {
      team_name: teamName,
      worktree_root: expectedRoot,
      manifest_path: manifestPath,
      manifest_status: manifestStatus,
      reasons: teamReasons,
      safe_to_delete_candidate: safeToDeleteCandidate,
      workers,
      errors
    };
    teams.push(entry);
    counts.teams += 1;

    for (const reason of entry.reasons) {
      if (
        reason === "manifest_owned" ||
        reason === "missing_manifest" ||
        reason === "invalid_manifest" ||
        (reason === "manual_review_required" && entry.workers.length === 0)
      ) {
        incrementDiagnosticCount(counts, reason);
      }
    }
    for (const worker of entry.workers) {
      for (const reason of worker.reasons) {
        incrementDiagnosticCount(counts, reason);
      }
    }
  }

  return {
    worktrees_root: worktreesRoot,
    counts,
    teams
  };
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
