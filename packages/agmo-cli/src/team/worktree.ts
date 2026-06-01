import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { writeJsonFile } from "../utils/fs.js";
import { uniqueRecommendedActions } from "../utils/machine-json.js";
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

export type TeamWorktreeDiagnosticClassification =
  | "cleanup_candidate"
  | "inspect_required"
  | "manual_review_required"
  | "already_missing";

export type TeamWorktreeGitNumstatFile = {
  path: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
};

export type TeamWorktreeGitSummary = {
  branch: string | null;
  head: string | null;
  status_porcelain: {
    count: number;
    entries: string[];
  };
  diff_numstat: {
    count: number;
    files: TeamWorktreeGitNumstatFile[];
  };
  head_merged_into_repo_head: boolean | null;
  errors: string[];
};

export type TeamWorktreeDiagnosticWorker = {
  worker_name: string;
  path: string;
  git_enabled: boolean;
  exists: boolean;
  is_git_worktree: boolean;
  git_worktree_registered: boolean;
  dirty: boolean;
  classification: TeamWorktreeDiagnosticClassification;
  recommended_actions: string[];
  git_summary?: TeamWorktreeGitSummary;
  reasons: TeamWorktreeDiagnosticReason[];
};

export type TeamWorktreeDiagnosticEntry = {
  team_name: string;
  worktree_root: string;
  manifest_path: string;
  manifest_status: "valid" | "missing" | "invalid";
  reasons: TeamWorktreeDiagnosticReason[];
  classification: TeamWorktreeDiagnosticClassification;
  recommended_actions: string[];
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

export type TeamWorktreeArchiveWorkerResult = {
  worker_name: string;
  path: string;
  classification: TeamWorktreeDiagnosticClassification;
  git_enabled: boolean;
  is_git_worktree: boolean;
  status: "archived" | "would_archive" | "skipped" | "failed";
  reason?: string;
  archive_paths: {
    summary_json?: string;
    status_txt?: string;
    diff_patch?: string;
    untracked_dir?: string;
  };
  untracked_files?: Array<{
    path: string;
    archive_path: string;
  }>;
  git_summary?: TeamWorktreeGitSummary;
};

export type TeamWorktreeArchiveSummary = {
  team_name: string;
  worker_name: string | null;
  dry_run: boolean;
  created_at: string;
  archive_root: string;
  status: "archived" | "would_archive" | "skipped" | "partial" | "failed";
  archived: number;
  skipped: number;
  failed: number;
  workers: TeamWorktreeArchiveWorkerResult[];
  errors: string[];
};

export type TeamWorktreeDiscardWorkerResult = {
  worker_name: string;
  path: string;
  classification: TeamWorktreeDiagnosticClassification;
  git_enabled: boolean;
  status: "removed" | "would_remove" | "skipped" | "refused" | "failed";
  reason?: string;
  archive?: TeamWorktreeArchiveWorkerResult;
};

export type TeamWorktreeDiscardSummary = {
  team_name: string;
  worker_name: string | null;
  dry_run: boolean;
  force: boolean;
  archive: boolean;
  status: "removed" | "would_remove" | "skipped" | "refused" | "partial" | "failed";
  removed: number;
  skipped: number;
  refused: number;
  failed: number;
  workers: TeamWorktreeDiscardWorkerResult[];
  archive_result?: TeamWorktreeArchiveSummary;
  errors: string[];
};

export type TeamWorktreePromoteSummary = {
  team_name: string;
  worker_name: string;
  dry_run: boolean;
  status: "promoted" | "would_promote" | "already_exists" | "refused" | "failed";
  worker_path: string | null;
  branch_name: string;
  current_branch: string | null;
  head: string | null;
  dirty: boolean;
  git_summary?: TeamWorktreeGitSummary;
  recommended_actions: string[];
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

function tryRunGit(args: string[], cwd = process.cwd()): string | null {
  try {
    return runGit(args, cwd);
  } catch {
    return null;
  }
}

function tryRunGitRaw(args: string[], cwd = process.cwd()): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"]
    }).replace(/\n$/, "");
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

async function canonicalPathForContainment(path: string): Promise<string> {
  const resolvedPath = resolve(path);
  if (existsSync(resolvedPath)) {
    return await canonicalExistingPath(resolvedPath);
  }

  const missingSegments: string[] = [];
  let cursor = resolvedPath;
  while (!existsSync(cursor)) {
    missingSegments.unshift(basename(cursor));
    const parent = dirname(cursor);
    if (parent === cursor) {
      return resolvedPath;
    }
    cursor = parent;
  }

  return join(await canonicalExistingPath(cursor), ...missingSegments);
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
    tryRunGitRaw(
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

function splitNonEmptyLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function parseGitNumstat(output: string): TeamWorktreeGitNumstatFile[] {
  return splitNonEmptyLines(output).map((line) => {
    const [additionsRaw, deletionsRaw, ...pathParts] = line.split("\t");
    return {
      path: pathParts.join("\t"),
      additions: additionsRaw === "-" ? null : Number.parseInt(additionsRaw ?? "0", 10),
      deletions: deletionsRaw === "-" ? null : Number.parseInt(deletionsRaw ?? "0", 10),
      binary: additionsRaw === "-" || deletionsRaw === "-"
    };
  });
}

function buildGitSummary(workerPath: string, repoRoot: string): TeamWorktreeGitSummary {
  const errors: string[] = [];
  const readGit = (args: string[], cwd: string): string | null => {
    const output = tryRunGit(args, cwd);
    if (output === null) {
      errors.push(`git ${args.join(" ")} failed in ${cwd}`);
    }
    return output;
  };

  const branch = readGit(["branch", "--show-current"], workerPath);
  const head = readGit(["rev-parse", "--verify", "HEAD"], workerPath);
  const statusEntries = splitNonEmptyLines(gitStatusPorcelainIgnoringRuntimeFiles(workerPath));
  const diffFiles = parseGitNumstat(readGit(["diff", "--numstat", "HEAD", "--"], workerPath) ?? "");
  let headMergedIntoRepoHead: boolean | null = null;

  if (head) {
    const repoHead = readGit(["rev-parse", "--verify", "HEAD"], repoRoot);
    if (repoHead) {
      headMergedIntoRepoHead = tryRunGit(["merge-base", "--is-ancestor", head, "HEAD"], repoRoot) !== null;
    }
  }

  return {
    branch: branch && branch.length > 0 ? branch : null,
    head: head && head.length > 0 ? head : null,
    status_porcelain: {
      count: statusEntries.length,
      entries: statusEntries
    },
    diff_numstat: {
      count: diffFiles.length,
      files: diffFiles
    },
    head_merged_into_repo_head: headMergedIntoRepoHead,
    errors
  };
}

function sanitizeArchiveSegment(value: string): string {
  return sanitizeTeamName(value).replace(/[^a-zA-Z0-9._-]/g, "-");
}

function timestampArchiveSegment(createdAt: string): string {
  return createdAt.replace(/[^0-9a-zA-Z]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function resolveTeamWorktreeArchiveRoot(teamName: string, cwd = process.cwd()): string {
  return resolve(cwd, ".agmo", "state", "team", sanitizeTeamName(teamName), "worktree-archive");
}

function gitDiffPatch(workerPath: string): string {
  return tryRunGitRaw(["diff", "--binary", "HEAD", "--"], workerPath) ?? "";
}

function gitUntrackedFiles(workerPath: string): string[] {
  try {
    const output = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: workerPath,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return output
      .toString("utf-8")
      .split("\0")
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function safeResolveRelativePath(root: string, relativePath: string): string | null {
  if (!relativePath || isAbsolute(relativePath)) {
    return null;
  }
  const resolved = resolve(root, relativePath);
  return isPathWithin(root, resolved) ? resolved : null;
}

async function archiveGitUntrackedFiles(
  workerPath: string,
  untrackedDir: string
): Promise<Array<{ path: string; archive_path: string }>> {
  const archived: Array<{ path: string; archive_path: string }> = [];
  for (const filePath of gitUntrackedFiles(workerPath)) {
    const source = safeResolveRelativePath(workerPath, filePath);
    const target = safeResolveRelativePath(untrackedDir, filePath);
    if (!source || !target) {
      throw new Error(`unsafe untracked path: ${filePath}`);
    }
    const sourceStats = await lstat(source);
    if (sourceStats.isSymbolicLink()) {
      throw new Error(`untracked path is a symlink: ${filePath}`);
    }
    if (!sourceStats.isFile()) {
      throw new Error(`untracked path is not a regular file: ${filePath}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    archived.push({
      path: filePath,
      archive_path: target
    });
  }
  return archived;
}

function branchExists(repoRoot: string, branchName: string): boolean {
  return tryRunGit(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], repoRoot) !== null;
}

function selectTeamDiagnostic(
  diagnostics: TeamWorktreeDiagnosticsSummary,
  teamName: string
): TeamWorktreeDiagnosticEntry | null {
  return diagnostics.teams.find((entry) => entry.team_name === sanitizeTeamName(teamName)) ?? null;
}

function selectDiagnosticWorkers(
  team: TeamWorktreeDiagnosticEntry,
  workerName?: string
): TeamWorktreeDiagnosticWorker[] {
  if (!workerName) {
    return team.workers;
  }
  return team.workers.filter((worker) => worker.worker_name === workerName);
}

function canArchiveWorker(worker: TeamWorktreeDiagnosticWorker): { ok: true } | { ok: false; reason: string } {
  if (!worker.exists) {
    return { ok: false, reason: "worker path does not exist" };
  }
  if (worker.reasons.includes("manual_review_required") && !worker.git_enabled) {
    return { ok: false, reason: "manual review required for non-git worker path" };
  }
  if (worker.git_enabled && !worker.is_git_worktree) {
    return { ok: false, reason: "git worker path is not a git worktree" };
  }
  return { ok: true };
}

function canDiscardWorker(
  worker: TeamWorktreeDiagnosticWorker,
  force: boolean
): { ok: true } | { ok: false; reason: string } {
  if (worker.classification === "cleanup_candidate" || worker.classification === "already_missing") {
    return { ok: true };
  }
  if (force) {
    return { ok: true };
  }
  return { ok: false, reason: `worker classification requires --force: ${worker.classification}` };
}

async function loadValidWorktreeManifestForOperation(
  normalizedTeamName: string,
  cwd: string
): Promise<TeamWorktreeManifest | null> {
  const manifest = await readTeamWorktreeManifest(normalizedTeamName, cwd);
  if (!manifest || !hasValidManifestShape(manifest) || manifest.team_name !== normalizedTeamName) {
    return null;
  }
  return manifest;
}

async function isManifestWorkerPathSafe(
  teamName: string,
  workerPath: string,
  cwd: string
): Promise<boolean> {
  const expectedRoot = resolveTeamWorktreeRoot(teamName, cwd);
  const expectedRootCanonical = await canonicalExistingPath(expectedRoot);
  const workerPathCanonical = await canonicalPathForContainment(workerPath);
  return isPathWithin(expectedRootCanonical, workerPathCanonical);
}

function classifyWorkerDiagnostic(
  worker: Pick<TeamWorktreeDiagnosticWorker, "exists" | "dirty" | "git_enabled" | "git_worktree_registered" | "reasons">
): TeamWorktreeDiagnosticClassification {
  if (!worker.exists) {
    return "already_missing";
  }
  if (worker.reasons.includes("manual_review_required")) {
    return "manual_review_required";
  }
  if (worker.dirty || (worker.git_enabled && !worker.git_worktree_registered)) {
    return "inspect_required";
  }
  return "cleanup_candidate";
}

function buildWorkerRecommendedActions(
  teamName: string,
  workerName: string,
  workerPath: string,
  classification: TeamWorktreeDiagnosticClassification,
  gitEnabled: boolean
): string[] {
  return uniqueRecommendedActions([
    classification === "cleanup_candidate"
      ? `team delete ${teamName} --dry-run --remove-worktrees`
      : undefined,
    classification === "inspect_required" || classification === "manual_review_required"
      ? `team worktree inspect ${teamName} ${workerName}`
      : undefined,
    gitEnabled && classification !== "already_missing"
      ? `git -C ${workerPath} status --short`
      : undefined,
    gitEnabled && classification !== "already_missing"
      ? `team integrate ${teamName} --worker ${workerName} --dry-run`
      : undefined
  ]);
}

function classifyTeamDiagnostic(
  manifestStatus: TeamWorktreeDiagnosticEntry["manifest_status"],
  safeToDeleteCandidate: boolean,
  teamReasons: TeamWorktreeDiagnosticReason[],
  workers: TeamWorktreeDiagnosticWorker[]
): TeamWorktreeDiagnosticClassification {
  if (manifestStatus === "valid" && workers.length > 0 && workers.every((worker) => !worker.exists)) {
    return "already_missing";
  }
  if (safeToDeleteCandidate) {
    return "cleanup_candidate";
  }
  if (teamReasons.includes("manual_review_required")) {
    return "manual_review_required";
  }
  return "inspect_required";
}

function buildTeamRecommendedActions(
  teamName: string,
  classification: TeamWorktreeDiagnosticClassification,
  workers: TeamWorktreeDiagnosticWorker[]
): string[] {
  return uniqueRecommendedActions([
    classification === "cleanup_candidate" || classification === "already_missing"
      ? `team delete ${teamName} --dry-run --remove-worktrees`
      : undefined,
    classification === "inspect_required" || classification === "manual_review_required"
      ? `team worktree inspect ${teamName}`
      : undefined,
    ...workers.flatMap((worker) => worker.recommended_actions)
  ]);
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
          const workerPathCanonical = await canonicalPathForContainment(workerPath);
          const workerReasons: TeamWorktreeDiagnosticReason[] = [];
          const exists = existsSync(workerPath);
          const workerPathWithinRoot = isPathWithin(expectedRootCanonical, workerPathCanonical);
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

          const classification = classifyWorkerDiagnostic({
            exists,
            dirty,
            git_enabled: worker.git_enabled,
            git_worktree_registered: gitWorktreeRegistered,
            reasons: workerReasons
          });
          const recommendedActions = buildWorkerRecommendedActions(
            teamName,
            worker.worker_name,
            worker.path,
            classification,
            worker.git_enabled
          );
          const gitSummary =
            exists && isGitWorktree
              ? buildGitSummary(workerPathCanonical, worker.repo_root)
              : undefined;

          workers.push({
            worker_name: worker.worker_name,
            path: worker.path,
            git_enabled: worker.git_enabled,
            exists,
            is_git_worktree: isGitWorktree,
            git_worktree_registered: gitWorktreeRegistered,
            dirty,
            classification,
            recommended_actions: recommendedActions,
            ...(gitSummary ? { git_summary: gitSummary } : {}),
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
    const classification = classifyTeamDiagnostic(
      manifestStatus,
      safeToDeleteCandidate,
      teamReasons,
      workers
    );

    const entry: TeamWorktreeDiagnosticEntry = {
      team_name: teamName,
      worktree_root: expectedRoot,
      manifest_path: manifestPath,
      manifest_status: manifestStatus,
      reasons: teamReasons,
      classification,
      recommended_actions: buildTeamRecommendedActions(teamName, classification, workers),
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

export async function archiveTeamWorktree(
  teamName: string,
  options: {
    workerName?: string;
    dryRun?: boolean;
    createdAt?: string;
  } = {},
  cwd = process.cwd()
): Promise<TeamWorktreeArchiveSummary> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const dryRun = options.dryRun === true;
  const createdAt = options.createdAt ?? new Date().toISOString();
  const archiveRoot = resolveTeamWorktreeArchiveRoot(normalizedTeamName, cwd);
  const diagnostics = await inspectTeamWorktrees(cwd);
  const team = selectTeamDiagnostic(diagnostics, normalizedTeamName);
  const selectedWorkers = team ? selectDiagnosticWorkers(team, options.workerName) : [];

  if (!team) {
    return {
      team_name: normalizedTeamName,
      worker_name: options.workerName ?? null,
      dry_run: dryRun,
      created_at: createdAt,
      archive_root: archiveRoot,
      status: "failed",
      archived: 0,
      skipped: 0,
      failed: 1,
      workers: [],
      errors: [`team not found: ${normalizedTeamName}`]
    };
  }
  if (options.workerName && selectedWorkers.length === 0) {
    return {
      team_name: normalizedTeamName,
      worker_name: options.workerName,
      dry_run: dryRun,
      created_at: createdAt,
      archive_root: archiveRoot,
      status: "failed",
      archived: 0,
      skipped: 0,
      failed: 1,
      workers: [],
      errors: [`worker not found: ${options.workerName}`]
    };
  }

  const manifest = await loadValidWorktreeManifestForOperation(normalizedTeamName, cwd);
  if (!manifest || team.manifest_status !== "valid") {
    return {
      team_name: normalizedTeamName,
      worker_name: options.workerName ?? null,
      dry_run: dryRun,
      created_at: createdAt,
      archive_root: archiveRoot,
      status: "failed",
      archived: 0,
      skipped: 0,
      failed: 1,
      workers: [],
      errors: ["worktree ownership manifest failed validation"]
    };
  }

  const workers: TeamWorktreeArchiveWorkerResult[] = [];
  const archiveBatchRoot = join(archiveRoot, timestampArchiveSegment(createdAt));
  for (const worker of selectedWorkers) {
    const archiveCheck = canArchiveWorker(worker);
    const workerArchiveDir = join(archiveBatchRoot, sanitizeArchiveSegment(worker.worker_name));
    const archivePaths: TeamWorktreeArchiveWorkerResult["archive_paths"] = {
      summary_json: join(workerArchiveDir, "summary.json"),
      ...(worker.is_git_worktree ? { status_txt: join(workerArchiveDir, "status.txt") } : {}),
      ...(worker.is_git_worktree ? { diff_patch: join(workerArchiveDir, "diff.patch") } : {}),
      ...(worker.is_git_worktree ? { untracked_dir: join(workerArchiveDir, "untracked") } : {})
    };
    if (!archiveCheck.ok) {
      workers.push({
        worker_name: worker.worker_name,
        path: worker.path,
        classification: worker.classification,
        git_enabled: worker.git_enabled,
        is_git_worktree: worker.is_git_worktree,
        status: "skipped",
        reason: archiveCheck.reason,
        archive_paths: {}
      });
      continue;
    }
    if (!(await isManifestWorkerPathSafe(normalizedTeamName, worker.path, cwd))) {
      workers.push({
        worker_name: worker.worker_name,
        path: worker.path,
        classification: worker.classification,
        git_enabled: worker.git_enabled,
        is_git_worktree: worker.is_git_worktree,
        status: "skipped",
        reason: "worker path escapes team worktree root",
        archive_paths: {}
      });
      continue;
    }

    if (dryRun) {
      workers.push({
        worker_name: worker.worker_name,
        path: worker.path,
        classification: worker.classification,
        git_enabled: worker.git_enabled,
        is_git_worktree: worker.is_git_worktree,
        status: "would_archive",
        archive_paths: archivePaths,
        ...(worker.git_summary ? { git_summary: worker.git_summary } : {})
      });
      continue;
    }

    try {
      await mkdir(workerArchiveDir, { recursive: true });
      const untrackedFiles =
        worker.is_git_worktree && archivePaths.untracked_dir
          ? await archiveGitUntrackedFiles(worker.path, archivePaths.untracked_dir)
          : [];
      const summary = {
        team_name: normalizedTeamName,
        worker_name: worker.worker_name,
        path: worker.path,
        classification: worker.classification,
        reasons: worker.reasons,
        git_enabled: worker.git_enabled,
        is_git_worktree: worker.is_git_worktree,
        git_worktree_registered: worker.git_worktree_registered,
        dirty: worker.dirty,
        created_at: createdAt,
        archive_paths: archivePaths,
        untracked_files: untrackedFiles,
        git_summary: worker.git_summary ?? null
      };
      await writeJsonFile(archivePaths.summary_json ?? join(workerArchiveDir, "summary.json"), summary);
      if (worker.is_git_worktree) {
        await writeFile(archivePaths.status_txt ?? join(workerArchiveDir, "status.txt"), gitStatusPorcelainIgnoringRuntimeFiles(worker.path), "utf-8");
        await writeFile(archivePaths.diff_patch ?? join(workerArchiveDir, "diff.patch"), gitDiffPatch(worker.path), "utf-8");
      }
      workers.push({
        worker_name: worker.worker_name,
        path: worker.path,
        classification: worker.classification,
        git_enabled: worker.git_enabled,
        is_git_worktree: worker.is_git_worktree,
        status: "archived",
        archive_paths: archivePaths,
        ...(untrackedFiles.length > 0 ? { untracked_files: untrackedFiles } : {}),
        ...(worker.git_summary ? { git_summary: worker.git_summary } : {})
      });
    } catch (error) {
      workers.push({
        worker_name: worker.worker_name,
        path: worker.path,
        classification: worker.classification,
        git_enabled: worker.git_enabled,
        is_git_worktree: worker.is_git_worktree,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
        archive_paths: archivePaths
      });
    }
  }

  const archived = workers.filter((worker) => worker.status === "archived").length;
  const skipped = workers.filter((worker) => worker.status === "skipped").length;
  const failed = workers.filter((worker) => worker.status === "failed").length;
  const wouldArchive = workers.filter((worker) => worker.status === "would_archive").length;
  const status: TeamWorktreeArchiveSummary["status"] =
    failed > 0
      ? archived > 0 || skipped > 0 || wouldArchive > 0
        ? "partial"
        : "failed"
      : dryRun && wouldArchive > 0
        ? "would_archive"
        : archived > 0
          ? "archived"
          : "skipped";

  return {
    team_name: normalizedTeamName,
    worker_name: options.workerName ?? null,
    dry_run: dryRun,
    created_at: createdAt,
    archive_root: archiveRoot,
    status,
    archived,
    skipped,
    failed,
    workers,
    errors: workers
      .filter((worker) => worker.status === "failed" || worker.status === "skipped")
      .map((worker) => `${worker.worker_name}: ${worker.reason ?? worker.status}`)
  };
}

export async function discardTeamWorktree(
  teamName: string,
  options: {
    workerName?: string;
    dryRun?: boolean;
    force?: boolean;
    archive?: boolean;
  } = {},
  cwd = process.cwd()
): Promise<TeamWorktreeDiscardSummary> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const force = options.force === true;
  const dryRun = options.dryRun === true || !force;
  const archive = options.archive === true;
  const diagnostics = await inspectTeamWorktrees(cwd);
  const team = selectTeamDiagnostic(diagnostics, normalizedTeamName);
  const selectedWorkers = team ? selectDiagnosticWorkers(team, options.workerName) : [];

  if (!team) {
    return {
      team_name: normalizedTeamName,
      worker_name: options.workerName ?? null,
      dry_run: dryRun,
      force,
      archive,
      status: "failed",
      removed: 0,
      skipped: 0,
      refused: 0,
      failed: 1,
      workers: [],
      errors: [`team not found: ${normalizedTeamName}`]
    };
  }
  if (options.workerName && selectedWorkers.length === 0) {
    return {
      team_name: normalizedTeamName,
      worker_name: options.workerName,
      dry_run: dryRun,
      force,
      archive,
      status: "failed",
      removed: 0,
      skipped: 0,
      refused: 0,
      failed: 1,
      workers: [],
      errors: [`worker not found: ${options.workerName}`]
    };
  }
  if (team.manifest_status !== "valid" || !(await loadValidWorktreeManifestForOperation(normalizedTeamName, cwd))) {
    return {
      team_name: normalizedTeamName,
      worker_name: options.workerName ?? null,
      dry_run: dryRun,
      force,
      archive,
      status: "failed",
      removed: 0,
      skipped: 0,
      refused: 0,
      failed: 1,
      workers: [],
      errors: ["worktree ownership manifest failed validation"]
    };
  }

  const archiveResult =
    archive && force && !dryRun
      ? await archiveTeamWorktree(normalizedTeamName, { workerName: options.workerName }, cwd)
      : undefined;
  const archiveByWorker = new Map(
    archiveResult?.workers.map((worker) => [worker.worker_name, worker]) ?? []
  );
  const workers: TeamWorktreeDiscardWorkerResult[] = [];

  for (const worker of selectedWorkers) {
    const discardCheck = canDiscardWorker(worker, force);
    const archivedWorker = archiveByWorker.get(worker.worker_name);
    if (!discardCheck.ok) {
      workers.push({
        worker_name: worker.worker_name,
        path: worker.path,
        classification: worker.classification,
        git_enabled: worker.git_enabled,
        status: "refused",
        reason: discardCheck.reason
      });
      continue;
    }
    if (archive && force && !dryRun && archivedWorker?.status !== "archived") {
      workers.push({
        worker_name: worker.worker_name,
        path: worker.path,
        classification: worker.classification,
        git_enabled: worker.git_enabled,
        status: "refused",
        reason: "archive did not complete",
        ...(archivedWorker ? { archive: archivedWorker } : {})
      });
      continue;
    }
    if (!(await isManifestWorkerPathSafe(normalizedTeamName, worker.path, cwd))) {
      workers.push({
        worker_name: worker.worker_name,
        path: worker.path,
        classification: worker.classification,
        git_enabled: worker.git_enabled,
        status: "refused",
        reason: "worker path escapes team worktree root",
        ...(archivedWorker ? { archive: archivedWorker } : {})
      });
      continue;
    }
    if (!worker.exists || worker.classification === "already_missing") {
      workers.push({
        worker_name: worker.worker_name,
        path: worker.path,
        classification: worker.classification,
        git_enabled: worker.git_enabled,
        status: "skipped",
        reason: "worker path does not exist",
        ...(archivedWorker ? { archive: archivedWorker } : {})
      });
      continue;
    }
    if (dryRun) {
      workers.push({
        worker_name: worker.worker_name,
        path: worker.path,
        classification: worker.classification,
        git_enabled: worker.git_enabled,
        status: "would_remove"
      });
      continue;
    }

    try {
      const workerPathCanonical = await canonicalExistingPath(worker.path);
      if (worker.git_enabled) {
        const manifestWorker = (await readTeamWorktreeManifest(normalizedTeamName, cwd))?.workers.find(
          (entry) => entry.worker_name === worker.worker_name
        );
        const repoRoot = await canonicalExistingPath(manifestWorker?.repo_root ?? worker.path);
        runGit(["worktree", "remove", ...(force ? ["--force"] : []), workerPathCanonical], repoRoot);
        runGit(["worktree", "prune"], repoRoot);
      } else {
        await rm(workerPathCanonical, { recursive: true, force: true });
      }
      workers.push({
        worker_name: worker.worker_name,
        path: worker.path,
        classification: worker.classification,
        git_enabled: worker.git_enabled,
        status: "removed",
        ...(archivedWorker ? { archive: archivedWorker } : {})
      });
    } catch (error) {
      workers.push({
        worker_name: worker.worker_name,
        path: worker.path,
        classification: worker.classification,
        git_enabled: worker.git_enabled,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
        ...(archivedWorker ? { archive: archivedWorker } : {})
      });
    }
  }

  const removed = workers.filter((worker) => worker.status === "removed").length;
  const skipped = workers.filter((worker) => worker.status === "skipped").length;
  const refused = workers.filter((worker) => worker.status === "refused").length;
  const failed = workers.filter((worker) => worker.status === "failed").length;
  const wouldRemove = workers.filter((worker) => worker.status === "would_remove").length;
  const status: TeamWorktreeDiscardSummary["status"] =
    failed > 0
      ? removed > 0 || skipped > 0 || refused > 0 || wouldRemove > 0
        ? "partial"
        : "failed"
      : refused > 0
        ? removed > 0 || skipped > 0 || wouldRemove > 0
          ? "partial"
          : "refused"
        : dryRun && wouldRemove > 0
          ? "would_remove"
          : removed > 0
            ? "removed"
            : "skipped";

  return {
    team_name: normalizedTeamName,
    worker_name: options.workerName ?? null,
    dry_run: dryRun,
    force,
    archive,
    status,
    removed,
    skipped,
    refused,
    failed,
    workers,
    ...(archiveResult ? { archive_result: archiveResult } : {}),
    errors: workers
      .filter((worker) => worker.status === "failed" || worker.status === "refused")
      .map((worker) => `${worker.worker_name}: ${worker.reason ?? worker.status}`)
  };
}

export async function promoteTeamWorktree(
  teamName: string,
  workerName: string,
  options: {
    branchName?: string;
    dryRun?: boolean;
  } = {},
  cwd = process.cwd()
): Promise<TeamWorktreePromoteSummary> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const dryRun = options.dryRun === true;
  const diagnostics = await inspectTeamWorktrees(cwd);
  const team = selectTeamDiagnostic(diagnostics, normalizedTeamName);
  const worker = team?.workers.find((entry) => entry.worker_name === workerName);
  const branchName =
    options.branchName ?? `agmo/preserved/${normalizedTeamName}/${sanitizeArchiveSegment(workerName)}`;

  const base = (
    status: TeamWorktreePromoteSummary["status"],
    values: Partial<TeamWorktreePromoteSummary>
  ): TeamWorktreePromoteSummary => ({
    team_name: normalizedTeamName,
    worker_name: workerName,
    dry_run: dryRun,
    status,
    worker_path: worker?.path ?? null,
    branch_name: branchName,
    current_branch: worker?.git_summary?.branch ?? null,
    head: worker?.git_summary?.head ?? null,
    dirty: worker?.dirty ?? false,
    ...(worker?.git_summary ? { git_summary: worker.git_summary } : {}),
    recommended_actions: [],
    errors: [],
    ...values
  });

  if (!team) {
    return base("failed", { errors: [`team not found: ${normalizedTeamName}`] });
  }
  if (!worker) {
    return base("failed", { errors: [`worker not found: ${workerName}`] });
  }
  if (!worker.exists || !worker.git_enabled || !worker.is_git_worktree) {
    return base("refused", {
      recommended_actions: [`team worktree inspect ${normalizedTeamName} ${workerName}`],
      errors: ["promote requires an existing git worker worktree"]
    });
  }
  if (!(await isManifestWorkerPathSafe(normalizedTeamName, worker.path, cwd))) {
    return base("refused", { errors: ["worker path escapes team worktree root"] });
  }

  const manifestWorker = (await readTeamWorktreeManifest(normalizedTeamName, cwd))?.workers.find(
    (entry) => entry.worker_name === workerName
  );
  const repoRoot = await canonicalExistingPath(manifestWorker?.repo_root ?? worker.path);
  if (branchExists(repoRoot, branchName)) {
    return base("already_exists", {
      recommended_actions: [`git -C ${repoRoot} branch --show-current`, `team worktree inspect ${normalizedTeamName} ${workerName}`]
    });
  }
  if (!worker.git_summary?.head) {
    return base("refused", { errors: ["worker HEAD could not be resolved"] });
  }
  if (worker.dirty) {
    return base("refused", {
      recommended_actions: [
        `team worktree archive ${normalizedTeamName} ${workerName}`,
        `git -C ${worker.path} status --short`
      ],
      errors: ["worker has uncommitted changes; archive or commit before promote"]
    });
  }
  if (dryRun) {
    return base("would_promote", {
      recommended_actions: [`git -C ${repoRoot} branch ${branchName} ${worker.git_summary.head}`]
    });
  }

  try {
    runGit(["branch", branchName, worker.git_summary.head], repoRoot);
    return base("promoted", {
      recommended_actions: [`git -C ${repoRoot} show --stat ${branchName}`]
    });
  } catch (error) {
    return base("failed", {
      errors: [error instanceof Error ? error.message : String(error)]
    });
  }
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
    const workerPathCanonical = await canonicalPathForContainment(workerPath);
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
