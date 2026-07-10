import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { DEFAULT_AGMO_LAUNCH_POLICY, resolveLaunchPolicy } from "../config/runtime.js";
import { resolveInstallPaths } from "../utils/paths.js";

const WORKSPACE_CACHE_DIR = "launch-workspaces";

export type LaunchWorkspaceSafetyMode = "safe" | "allow-active";

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

export type LaunchWorkspaceDeletionCheck =
  | { ok: true; metadata: LaunchWorkspaceMetadata; derived: LaunchWorkspaceDerivedState }
  | { ok: false; skip_reason: string };

function parseIsoTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isPidAlive(pid: number | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
    options.heartbeatStaleAfterMs ?? DEFAULT_AGMO_LAUNCH_POLICY.heartbeat_stale_after_ms;
  const heartbeatFresh =
    lastSeenAtMs !== null && now - lastSeenAtMs <= heartbeatStaleAfterMs;
  const active =
    metadata.active === true && (codexPidAlive || launcherPidAlive || heartbeatFresh);
  const stale = metadata.active === true && !active;
  const createdAtMs = parseIsoTimestamp(metadata.created_at);
  const referenceAt = metadata.last_seen_at ?? metadata.last_exit_at ?? metadata.created_at ?? null;
  const referenceAtMs = parseIsoTimestamp(referenceAt ?? undefined);

  return {
    state: active ? "active" : stale ? "stale" : "inactive",
    active,
    stale,
    codex_pid_alive: codexPidAlive,
    launcher_pid_alive: launcherPidAlive,
    heartbeat_fresh: heartbeatFresh,
    created_age_hours: createdAtMs === null ? null : Number(((now - createdAtMs) / 36e5).toFixed(2)),
    reference_at: referenceAt,
    reference_age_hours:
      referenceAtMs === null ? null : Number(((now - referenceAtMs) / 36e5).toFixed(2))
  };
}

export async function readLaunchWorkspaceMetadata(
  metadataPath: string
): Promise<LaunchWorkspaceMetadata | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const metadata = parsed as Partial<LaunchWorkspaceMetadata>;
  return typeof metadata.session_id === "string" &&
    typeof metadata.project_root === "string" &&
    typeof metadata.workspace_root === "string" &&
    typeof metadata.composed_agents_path === "string" &&
    typeof metadata.created_at === "string"
    ? (metadata as LaunchWorkspaceMetadata)
    : null;
}

async function readMetadataForDeletion(metadataPath: string): Promise<
  | { ok: true; metadata: LaunchWorkspaceMetadata }
  | { ok: false; skip_reason: "launch metadata missing before deletion" | "launch metadata malformed before deletion" }
> {
  let content;
  try {
    content = await readFile(metadataPath, "utf8");
  } catch {
    return { ok: false, skip_reason: "launch metadata missing before deletion" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return { ok: false, skip_reason: "launch metadata malformed before deletion" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, skip_reason: "launch metadata malformed before deletion" };
  }
  const metadata = parsed as Partial<LaunchWorkspaceMetadata>;
  return typeof metadata.session_id === "string" &&
    typeof metadata.project_root === "string" &&
    typeof metadata.workspace_root === "string" &&
    typeof metadata.composed_agents_path === "string" &&
    typeof metadata.created_at === "string"
    ? { ok: true, metadata: metadata as LaunchWorkspaceMetadata }
    : { ok: false, skip_reason: "launch metadata malformed before deletion" };
}

function safeSessionId(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    basename(value) === value &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function gitDirtyState(path: string): "clean" | "dirty" | "unknown" {
  try {
    const output = execFileSync("git", ["-C", path, "status", "--short"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    return output ? "dirty" : "clean";
  } catch {
    return "unknown";
  }
}

async function pathsReferToSameLocation(left: string, right: string): Promise<boolean> {
  const [leftReal, rightReal] = await Promise.all([
    realpath(left).catch(() => resolve(left)),
    realpath(right).catch(() => resolve(right))
  ]);
  return leftReal === rightReal;
}

async function canonicalPath(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function recordLooksActive(record: Record<string, unknown>): boolean {
  if (record.active === true) {
    return true;
  }
  const status = typeof record.status === "string" ? record.status : "";
  const state = typeof record.state === "string" ? record.state : "";
  const workflowStatus = typeof record.workflow_status === "string" ? record.workflow_status : "";
  return [status, state, workflowStatus].some((value) => ["active", "running", "in_progress"].includes(value));
}

async function checkLinkedStateRecords(
  projectRoot: string,
  sessionId: string,
  mode: LaunchWorkspaceSafetyMode
): Promise<string | null> {
  for (const path of [
    join(projectRoot, ".agmo", "state", "sessions", `${sessionId}.json`),
    join(projectRoot, ".agmo", "state", "workflows", `${sessionId}.json`)
  ]) {
    const record = await readJsonObject(path);
    if (!record) {
      continue;
    }
    if (typeof record.session_id === "string" && record.session_id !== sessionId) {
      return "launch session identity changed before deletion";
    }
    if (mode === "safe" && recordLooksActive(record)) {
      return "launch workspace active before deletion";
    }
  }
  return null;
}

export async function checkLaunchWorkspaceDeletionSafety(args: {
  workspaceDir: string;
  plannedSessionId?: string | null;
  projectRoot?: string;
  mode?: LaunchWorkspaceSafetyMode;
}): Promise<LaunchWorkspaceDeletionCheck> {
  const mode = args.mode ?? "safe";
  let stats;
  try {
    stats = await lstat(args.workspaceDir);
  } catch {
    return { ok: false, skip_reason: "launch metadata missing before deletion" };
  }
  if (stats.isSymbolicLink()) {
    return { ok: false, skip_reason: "planned path is now a symlink" };
  }
  if (!stats.isDirectory()) {
    return { ok: false, skip_reason: "planned path kind is not safely deletable" };
  }

  const metadataResult = await readMetadataForDeletion(join(args.workspaceDir, "metadata.json"));
  if (!metadataResult.ok) {
    return { ok: false, skip_reason: metadataResult.skip_reason };
  }
  const metadata = metadataResult.metadata;
  if (!safeSessionId(metadata.session_id)) {
    return { ok: false, skip_reason: "launch metadata malformed before deletion" };
  }
  const plannedSessionId = args.plannedSessionId ?? basename(args.workspaceDir);
  const workspaceRootMatches = await pathsReferToSameLocation(
    join(args.workspaceDir, "workspace"),
    metadata.workspace_root
  );
  if (metadata.session_id !== plannedSessionId || basename(args.workspaceDir) !== plannedSessionId || !workspaceRootMatches) {
    return { ok: false, skip_reason: "launch session identity changed before deletion" };
  }

  if (args.projectRoot) {
    const [suppliedProjectRoot, metadataProjectRoot] = await Promise.all([
      canonicalPath(args.projectRoot),
      canonicalPath(metadata.project_root)
    ]);
    const expectedWorkspaceDir = join(
      resolveInstallPaths("project", suppliedProjectRoot).cacheDir,
      WORKSPACE_CACHE_DIR,
      plannedSessionId
    );
    const workspaceDirMatchesExpected = await pathsReferToSameLocation(args.workspaceDir, expectedWorkspaceDir);
    if (suppliedProjectRoot !== metadataProjectRoot || !workspaceDirMatchesExpected) {
      return { ok: false, skip_reason: "launch session identity changed before deletion" };
    }
  }

  const launchPolicy = await resolveLaunchPolicy(args.projectRoot ?? metadata.project_root).catch(() => null);
  const derived = deriveLaunchWorkspaceState(metadata, {
    heartbeatStaleAfterMs: launchPolicy?.policy.heartbeat_stale_after_ms
  });
  if (derived.state === "unknown") {
    return { ok: false, skip_reason: "launch workspace state unknown before deletion" };
  }
  if (mode === "safe" && derived.active) {
    return { ok: false, skip_reason: "launch workspace active before deletion" };
  }
  const stateRecordSkip = await checkLinkedStateRecords(
    args.projectRoot ?? metadata.project_root,
    metadata.session_id,
    mode
  );
  if (stateRecordSkip) {
    return { ok: false, skip_reason: stateRecordSkip };
  }

  const dirty = gitDirtyState(metadata.workspace_root);
  if (dirty === "dirty") {
    return { ok: false, skip_reason: "launch workspace dirty before deletion" };
  }
  if (dirty === "unknown") {
    return { ok: false, skip_reason: "launch workspace dirty state unknown before deletion" };
  }

  return { ok: true, metadata, derived };
}
