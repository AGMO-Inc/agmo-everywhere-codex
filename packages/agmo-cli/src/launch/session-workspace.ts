import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  rm,
  symlink
} from "node:fs/promises";
import { basename, join } from "node:path";
import {
  DEFAULT_AGMO_LAUNCH_POLICY,
  resolveLaunchPolicy
} from "../config/runtime.js";
import { readTextFileIfExists, writeTextFile } from "../utils/fs.js";
import { resolveInstallPaths } from "../utils/paths.js";
import {
  removeSessionComposedAgentsFile,
  writeSessionComposedAgentsFile
} from "../agents/agents-md.js";

const WORKSPACE_CACHE_DIR = "launch-workspaces";
const WORKSPACE_SKIPPED_DIRS = new Set(["node_modules"]);

export type LaunchWorkspaceMetadata = {
  session_id: string;
  project_root: string;
  workspace_root: string;
  composed_agents_path: string;
  created_at: string;
  active?: boolean;
  launcher_pid?: number;
  codex_pid?: number;
  last_seen_at?: string;
  last_exit_at?: string;
  last_exit_code?: number;
};

export type LaunchWorkspaceRecord = {
  session_id: string;
  workspace_dir: string;
  metadata_path: string;
  metadata: LaunchWorkspaceMetadata | null;
  derived: LaunchWorkspaceDerivedState;
};

export type LaunchWorkspaceDerivedState = {
  state: "active" | "stale" | "inactive" | "unknown";
  active: boolean;
  stale: boolean;
  codex_pid_alive: boolean;
  launcher_pid_alive: boolean;
  heartbeat_fresh: boolean;
  created_age_hours: number | null;
  reference_at: string | null;
  reference_age_hours: number | null;
};

function createLaunchSessionId(): string {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  return `launch-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function buildRuntimeOverlay(args: {
  sessionId: string;
  projectRoot: string;
  workspaceRoot: string;
}): string {
  return [
    "## Agmo Launch Runtime Overlay",
    `- launch_session_id: ${args.sessionId}`,
    `- project_root: ${args.projectRoot}`,
    `- session_workspace_root: ${args.workspaceRoot}`,
    "- This session was launched through `agmo launch`, so the current working directory is a session-local Git sandbox.",
    "- Treat the session workspace `AGENTS.md` as the active main-session orchestrator contract for this run.",
    "- Persist durable runtime state against the real project root, not the session workspace cache root."
  ].join("\n");
}

function shouldLinkEntry(name: string): boolean {
  return name !== "AGENTS.md" && name !== ".agmo" && name !== ".git";
}

function resolveLaunchWorkspaceCacheDir(projectRoot: string): string {
  return join(resolveInstallPaths("project", projectRoot).cacheDir, WORKSPACE_CACHE_DIR);
}

function parseIsoTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function runGit(args: string[], cwd = process.cwd()): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function formatGitError(error: unknown): string {
  if (error instanceof Error) {
    const stderr =
      "stderr" in error &&
      (typeof error.stderr === "string" || Buffer.isBuffer(error.stderr))
        ? String(error.stderr)
        : "";

    return `${error.message}\n${stderr}`.trim();
  }

  return String(error);
}

function shouldRetryCloneWithoutHardlinks(error: unknown): boolean {
  const detail = formatGitError(error);

  return (
    detail.includes("failed to create link") ||
    detail.includes("Operation not permitted") ||
    detail.includes("Invalid cross-device link")
  );
}

function isGitRepository(cwd = process.cwd()): boolean {
  try {
    return runGit(["rev-parse", "--is-inside-work-tree"], cwd) === "true";
  } catch {
    return false;
  }
}

function isTrackedInGit(path: string, cwd = process.cwd()): boolean {
  try {
    runGit(["ls-files", "--error-unmatch", path], cwd);
    return true;
  } catch {
    return false;
  }
}

function isPidAlive(pid: number | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function readLaunchWorkspaceMetadata(
  metadataPath: string
): Promise<LaunchWorkspaceMetadata | null> {
  const content = await readTextFileIfExists(metadataPath);
  if (!content) {
    return null;
  }

  try {
    return JSON.parse(content) as LaunchWorkspaceMetadata;
  } catch {
    return null;
  }
}

async function writeLaunchWorkspaceMetadata(
  metadataPath: string,
  metadata: LaunchWorkspaceMetadata
): Promise<void> {
  await writeTextFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

export function deriveLaunchWorkspaceState(
  metadata: LaunchWorkspaceMetadata | null | undefined,
  options: {
    heartbeatStaleAfterMs?: number;
  } = {}
): LaunchWorkspaceDerivedState {
  if (!metadata) {
    return {
      state: "unknown",
      active: false,
      stale: false,
      codex_pid_alive: false,
      launcher_pid_alive: false,
      heartbeat_fresh: false,
      created_age_hours: null,
      reference_at: null,
      reference_age_hours: null
    };
  }

  const codexPidAlive = isPidAlive(metadata.codex_pid);
  const launcherPidAlive = isPidAlive(metadata.launcher_pid);
  const now = Date.now();
  const lastSeenAtMs = parseIsoTimestamp(metadata.last_seen_at);
  const heartbeatStaleAfterMs =
    options.heartbeatStaleAfterMs ??
    DEFAULT_AGMO_LAUNCH_POLICY.heartbeat_stale_after_ms;
  const heartbeatFresh =
    lastSeenAtMs !== null && now - lastSeenAtMs <= heartbeatStaleAfterMs;
  const active =
    metadata.active === true &&
    (codexPidAlive || launcherPidAlive || heartbeatFresh);
  const stale = metadata.active === true && !active;
  const createdAtMs = parseIsoTimestamp(metadata.created_at);
  const referenceAt =
    metadata.last_seen_at ?? metadata.last_exit_at ?? metadata.created_at ?? null;
  const referenceAtMs = parseIsoTimestamp(referenceAt ?? undefined);

  return {
    state: active ? "active" : stale ? "stale" : "inactive",
    active,
    stale,
    codex_pid_alive: codexPidAlive,
    launcher_pid_alive: launcherPidAlive,
    heartbeat_fresh: heartbeatFresh,
    created_age_hours:
      createdAtMs === null ? null : Number(((now - createdAtMs) / 36e5).toFixed(2)),
    reference_at: referenceAt,
    reference_age_hours:
      referenceAtMs === null ? null : Number(((now - referenceAtMs) / 36e5).toFixed(2))
  };
}

async function linkEntry(args: {
  sourcePath: string;
  destinationPath: string;
}): Promise<void> {
  const sourceStats = await lstat(args.sourcePath);
  if (sourceStats.isSymbolicLink()) {
    await symlink(await readlink(args.sourcePath), args.destinationPath);
    return;
  }

  const type =
    sourceStats.isDirectory() && process.platform === "win32" ? "junction" : undefined;
  await symlink(args.sourcePath, args.destinationPath, type);
}

async function copyWorkspaceFile(args: {
  sourcePath: string;
  destinationPath: string;
}): Promise<void> {
  await copyFile(args.sourcePath, args.destinationPath);
}

function shouldSkipDirectory(sourcePath: string): boolean {
  return WORKSPACE_SKIPPED_DIRS.has(basename(sourcePath));
}

async function mirrorWorkspaceEntry(args: {
  sourcePath: string;
  destinationPath: string;
}): Promise<void> {
  const sourceStats = await lstat(args.sourcePath);

  if (sourceStats.isSymbolicLink()) {
    await linkEntry(args);
    return;
  }

  if (sourceStats.isDirectory() && shouldSkipDirectory(args.sourcePath)) {
    return;
  }

  if (!sourceStats.isDirectory()) {
    await copyWorkspaceFile(args);
    return;
  }

  await mkdir(args.destinationPath, { recursive: true });
  const entries = await readdir(args.sourcePath, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      await mirrorWorkspaceEntry({
        sourcePath: join(args.sourcePath, entry.name),
        destinationPath: join(args.destinationPath, entry.name)
      });
    })
  );
}

async function clearWorkspaceRoot(workspaceRoot: string): Promise<void> {
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.name !== ".git")
      .map((entry) =>
        rm(join(workspaceRoot, entry.name), {
          recursive: true,
          force: true
        })
      )
  );
}

export function cloneGitWorkspace(args: {
  projectRoot: string;
  workspaceRoot: string;
  gitRunner?: typeof runGit;
}): void {
  const gitRunner = args.gitRunner ?? runGit;

  try {
    gitRunner(["clone", "--local", args.projectRoot, args.workspaceRoot], args.projectRoot);
  } catch (error) {
    if (!shouldRetryCloneWithoutHardlinks(error)) {
      throw error;
    }

    gitRunner(
      ["clone", "--local", "--no-hardlinks", args.projectRoot, args.workspaceRoot],
      args.projectRoot
    );
  }
}

async function initializeGitWorkspace(args: {
  projectRoot: string;
  workspaceRoot: string;
}): Promise<void> {
  cloneGitWorkspace(args);
  await clearWorkspaceRoot(args.workspaceRoot);
}

async function markSessionAgentsIgnored(workspaceRoot: string): Promise<void> {
  if (!isTrackedInGit("AGENTS.md", workspaceRoot)) {
    return;
  }

  runGit(["update-index", "--skip-worktree", "--", "AGENTS.md"], workspaceRoot);
}

export async function prepareSessionWorkspace(args: {
  projectRoot?: string;
  sessionId?: string;
}): Promise<{
  sessionId: string;
  workspaceDir: string;
  workspaceRoot: string;
  composedAgentsPath: string;
  metadataPath: string;
}> {
  const projectRoot = args.projectRoot ?? process.cwd();
  const sessionId = args.sessionId ?? createLaunchSessionId();
  const paths = resolveInstallPaths("project", projectRoot);
  const workspaceDir = join(resolveLaunchWorkspaceCacheDir(projectRoot), sessionId);
  const workspaceRoot = join(workspaceDir, "workspace");

  await rm(workspaceDir, { recursive: true, force: true });
  await mkdir(workspaceDir, { recursive: true });

  if (isGitRepository(projectRoot)) {
    await initializeGitWorkspace({
      projectRoot,
      workspaceRoot
    });
  } else {
    await mkdir(workspaceRoot, { recursive: true });
  }

  const composedAgents = await writeSessionComposedAgentsFile({
    cwd: projectRoot,
    sessionId,
    runtimeOverlay: buildRuntimeOverlay({
      sessionId,
      projectRoot,
      workspaceRoot
    })
  });

  const composedContent = await readTextFileIfExists(composedAgents.path);
  if (!composedContent) {
    throw new Error("failed to compose session AGENTS.md");
  }

  const entries = await readdir(projectRoot, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => shouldLinkEntry(entry.name))
      .map(async (entry) => {
        await mirrorWorkspaceEntry({
          sourcePath: join(projectRoot, entry.name),
          destinationPath: join(workspaceRoot, entry.name)
        });
      })
  );

  await writeTextFile(join(workspaceRoot, "AGENTS.md"), composedContent);
  if (isGitRepository(workspaceRoot)) {
    await markSessionAgentsIgnored(workspaceRoot);
  }

  const metadataPath = join(workspaceDir, "metadata.json");
  await writeLaunchWorkspaceMetadata(metadataPath, {
    session_id: sessionId,
    project_root: projectRoot,
    workspace_root: workspaceRoot,
    composed_agents_path: composedAgents.path,
    created_at: new Date().toISOString(),
    active: false
  });

  return {
    sessionId,
    workspaceDir,
    workspaceRoot,
    composedAgentsPath: composedAgents.path,
    metadataPath
  };
}

export async function recordLaunchWorkspaceStarted(args: {
  metadataPath: string;
  codexPid?: number;
  launcherPid?: number;
}): Promise<void> {
  const metadata = await readLaunchWorkspaceMetadata(args.metadataPath);
  if (!metadata) {
    return;
  }

  await writeLaunchWorkspaceMetadata(args.metadataPath, {
    ...metadata,
    active: true,
    launcher_pid: args.launcherPid,
    codex_pid: args.codexPid,
    last_seen_at: new Date().toISOString()
  });
}

export async function recordLaunchWorkspaceHeartbeat(args: {
  metadataPath: string;
}): Promise<void> {
  const metadata = await readLaunchWorkspaceMetadata(args.metadataPath);
  if (!metadata) {
    return;
  }

  await writeLaunchWorkspaceMetadata(args.metadataPath, {
    ...metadata,
    last_seen_at: new Date().toISOString()
  });
}

export async function recordLaunchWorkspaceExit(args: {
  metadataPath: string;
  exitCode: number;
}): Promise<void> {
  const metadata = await readLaunchWorkspaceMetadata(args.metadataPath);
  if (!metadata) {
    return;
  }

  await writeLaunchWorkspaceMetadata(args.metadataPath, {
    ...metadata,
    active: false,
    last_seen_at: new Date().toISOString(),
    last_exit_at: new Date().toISOString(),
    last_exit_code: args.exitCode
  });
}

export async function listLaunchWorkspaces(args: {
  projectRoot?: string;
} = {}): Promise<LaunchWorkspaceRecord[]> {
  const projectRoot = args.projectRoot ?? process.cwd();
  const cacheDir = resolveLaunchWorkspaceCacheDir(projectRoot);
  const launchPolicy = await resolveLaunchPolicy(projectRoot);

  try {
    const entries = await readdir(cacheDir, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));

    return await Promise.all(
      directories.map(async (name) => {
        const workspaceDir = join(cacheDir, name);
        const metadataPath = join(workspaceDir, "metadata.json");
        const metadata = await readLaunchWorkspaceMetadata(metadataPath);
        return {
          session_id: name,
          workspace_dir: workspaceDir,
          metadata_path: metadataPath,
          metadata,
          derived: deriveLaunchWorkspaceState(metadata, {
            heartbeatStaleAfterMs:
              launchPolicy.policy.heartbeat_stale_after_ms
          })
        } satisfies LaunchWorkspaceRecord;
      })
    );
  } catch {
    return [];
  }
}

export async function cleanupLaunchWorkspaces(args: {
  projectRoot?: string;
  all?: boolean;
  olderThanHours?: number;
  includeActive?: boolean;
  staleOnly?: boolean;
} = {}): Promise<{
  cache_dir: string;
  older_than_hours: number;
  stale_only: boolean;
  removed: Array<{
    session_id: string;
    workspace_dir: string;
    removed_session_agents: boolean;
  }>;
  kept: Array<{
    session_id: string;
    workspace_dir: string;
    reason: string;
  }>;
}> {
  const projectRoot = args.projectRoot ?? process.cwd();
  const cacheDir = resolveLaunchWorkspaceCacheDir(projectRoot);
  const launchPolicy = await resolveLaunchPolicy(projectRoot);
  const records = await listLaunchWorkspaces({ projectRoot });
  const staleOnly = args.staleOnly === true;
  const olderThanHours = args.all
    ? 0
    : Math.max(
        args.olderThanHours ??
          (staleOnly
            ? 0
            : launchPolicy.policy.default_cleanup_older_than_hours),
        0
      );
  const cutoffMs = Date.now() - olderThanHours * 60 * 60 * 1000;
  const removed: Array<{
    session_id: string;
    workspace_dir: string;
    removed_session_agents: boolean;
  }> = [];
  const kept: Array<{
    session_id: string;
    workspace_dir: string;
    reason: string;
  }> = [];

  for (const record of records) {
    if (args.includeActive !== true && record.derived.active) {
      kept.push({
        session_id: record.session_id,
        workspace_dir: record.workspace_dir,
        reason: "active codex process"
      });
      continue;
    }

    if (staleOnly && record.derived.stale !== true) {
      kept.push({
        session_id: record.session_id,
        workspace_dir: record.workspace_dir,
        reason: "not stale"
      });
      continue;
    }

    const referenceTimestamp =
      parseIsoTimestamp(record.metadata?.last_exit_at) ??
      parseIsoTimestamp(record.metadata?.created_at);

    const shouldRemove =
      args.all === true ||
      (referenceTimestamp !== null ? referenceTimestamp <= cutoffMs : true);

    if (!shouldRemove) {
      kept.push({
        session_id: record.session_id,
        workspace_dir: record.workspace_dir,
        reason:
          staleOnly && record.derived.stale
            ? "stale but newer than prune threshold"
            : "newer than prune threshold"
      });
      continue;
    }

    await rm(record.workspace_dir, { recursive: true, force: true });
    let removedSessionAgents = false;
    const sessionId = record.metadata?.session_id ?? record.session_id;
    if (sessionId) {
      await removeSessionComposedAgentsFile({
        cwd: projectRoot,
        sessionId
      });
      removedSessionAgents = true;
    }

    removed.push({
      session_id: record.session_id,
      workspace_dir: record.workspace_dir,
      removed_session_agents: removedSessionAgents
    });
  }

  return {
    cache_dir: cacheDir,
    older_than_hours: olderThanHours,
    stale_only: staleOnly,
    removed,
    kept
  };
}
