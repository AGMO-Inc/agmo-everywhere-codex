import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { resolveCleanupPolicy } from "../config/runtime.js";
import { listLaunchWorkspaces, type LaunchWorkspaceRecord } from "../launch/session-workspace.js";
import { inspectTeamWorktrees } from "../team/worktree.js";
import { resolveInstallPaths } from "../utils/paths.js";

export type CleanupInventoryCategory =
  | "state/sessions"
  | "state/workflows"
  | "state/team"
  | "cache/launch-workspaces"
  | "cache/session-instructions"
  | "handoffs"
  | "logs"
  | "memory"
  | "worktrees"
  | "backups/setup";

export type CleanupInventoryEntry = {
  category: CleanupInventoryCategory;
  path: string;
  relative_path: string;
  bytes: number;
  mtime_ms: number | null;
  kind: "file" | "directory" | "symlink" | "missing" | "unknown";
  ownership: "agmo-known" | "agmo-runtime" | "manual-review" | "unknown";
  cleanup_eligible: false;
  keep_reason: string;
  details?: Record<string, unknown>;
};

export type CleanupInventoryCategorySummary = {
  category: CleanupInventoryCategory;
  entries: number;
  bytes: number;
  cleanup_candidate_entries: number;
  cleanup_candidate_bytes: number;
};

export type CleanupInventorySummary = {
  project_root: string;
  agmo_dir: string;
  policy: Awaited<ReturnType<typeof resolveCleanupPolicy>>;
  totals: {
    entries: number;
    bytes: number;
    cleanup_candidate_entries: number;
    cleanup_candidate_bytes: number;
  };
  categories: CleanupInventoryCategorySummary[];
  entries: CleanupInventoryEntry[];
};

const CATEGORY_PATHS: Array<{ category: CleanupInventoryCategory; parts: string[] }> = [
  { category: "state/sessions", parts: ["state", "sessions"] },
  { category: "state/workflows", parts: ["state", "workflows"] },
  { category: "state/team", parts: ["state", "team"] },
  { category: "cache/launch-workspaces", parts: ["cache", "launch-workspaces"] },
  { category: "cache/session-instructions", parts: ["cache", "session-instructions"] },
  { category: "handoffs", parts: ["handoffs"] },
  { category: "logs", parts: ["logs"] },
  { category: "memory", parts: ["memory"] },
  { category: "worktrees", parts: ["worktrees"] },
  { category: "backups/setup", parts: ["backups", "setup"] }
];

function relativePath(projectRoot: string, path: string): string {
  return relative(projectRoot, path) || ".";
}

function entryKind(statsType: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): CleanupInventoryEntry["kind"] {
  if (statsType.isSymbolicLink()) {
    return "symlink";
  }
  if (statsType.isDirectory()) {
    return "directory";
  }
  if (statsType.isFile()) {
    return "file";
  }
  return "unknown";
}

async function measurePath(path: string): Promise<{
  bytes: number;
  mtime_ms: number | null;
  kind: CleanupInventoryEntry["kind"];
}> {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    return { bytes: 0, mtime_ms: null, kind: "missing" };
  }

  const kind = entryKind(stats);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return { bytes: stats.size, mtime_ms: stats.mtimeMs, kind };
  }

  let bytes = stats.size;
  let mtimeMs = stats.mtimeMs;
  let children;
  try {
    children = await readdir(path, { withFileTypes: true });
  } catch {
    return { bytes, mtime_ms: mtimeMs, kind };
  }

  for (const child of children) {
    const measured = await measurePath(join(path, child.name));
    bytes += measured.bytes;
    if (measured.mtime_ms !== null) {
      mtimeMs = Math.max(mtimeMs, measured.mtime_ms);
    }
  }

  return { bytes, mtime_ms: mtimeMs, kind };
}

async function listCategoryEntries(root: string): Promise<string[]> {
  if (!existsSync(root)) {
    return [];
  }

  const stats = await lstat(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return [root];
  }

  const children = await readdir(root, { withFileTypes: true });
  return children.map((child) => join(root, child.name)).sort((a, b) => a.localeCompare(b));
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function gitStatus(path: string): { status: "clean" | "dirty" | "unknown"; entries: string[] } {
  try {
    const output = execFileSync("git", ["-C", path, "status", "--short"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    const entries = output ? output.split("\n") : [];
    return { status: entries.length > 0 ? "dirty" : "clean", entries };
  } catch {
    return { status: "unknown", entries: [] };
  }
}

function launchRecordForPath(
  records: LaunchWorkspaceRecord[],
  entryPath: string
): LaunchWorkspaceRecord | undefined {
  return records.find((record) => resolve(record.workspace_dir) === resolve(entryPath));
}

async function launchWorkspaceDetails(
  entryPath: string,
  records: LaunchWorkspaceRecord[]
): Promise<Pick<CleanupInventoryEntry, "ownership" | "keep_reason" | "details">> {
  const record = launchRecordForPath(records, entryPath);
  const metadata =
    record?.metadata ?? (await readJsonFile(join(entryPath, "metadata.json")));
  const workspaceRoot =
    typeof metadata?.workspace_root === "string" ? metadata.workspace_root : null;
  const dirty = workspaceRoot ? gitStatus(workspaceRoot) : { status: "unknown" as const, entries: [] };
  const derivedState = record?.derived.state ?? "unknown";
  const keepReason =
    derivedState === "active"
      ? "active launch workspace"
      : dirty.status === "dirty"
        ? "dirty launch workspace"
        : dirty.status === "unknown"
          ? "unknown launch workspace dirty state"
          : "inspect-only slice does not delete launch workspaces";

  return {
    ownership: metadata ? "agmo-runtime" : "manual-review",
    keep_reason: keepReason,
    details: {
      session_id: metadata?.session_id ?? basename(entryPath),
      derived_state: derivedState,
      workspace_root: workspaceRoot,
      dirty_state: dirty.status,
      dirty_entries: dirty.entries.slice(0, 20)
    }
  };
}

function worktreeDetails(
  entryPath: string,
  worktreeSummary: Awaited<ReturnType<typeof inspectTeamWorktrees>>
): Pick<CleanupInventoryEntry, "ownership" | "keep_reason" | "details"> {
  const teamName = basename(entryPath);
  const team = worktreeSummary.teams.find((entry) => entry.team_name === teamName);
  if (!team) {
    return {
      ownership: "unknown",
      keep_reason: "worktree ownership unknown",
      details: { team_name: teamName }
    };
  }

  return {
    ownership: team.manifest_status === "valid" ? "agmo-runtime" : "manual-review",
    keep_reason: team.safe_to_delete_candidate
      ? "confirmed cleanup required for worktree cleanup candidate"
      : "worktree requires keep or manual review",
    details: {
      team_name: team.team_name,
      manifest_status: team.manifest_status,
      classification: team.classification,
      safe_to_delete_candidate: team.safe_to_delete_candidate,
      reasons: team.reasons
    }
  };
}

function defaultDetails(
  category: CleanupInventoryCategory
): Pick<CleanupInventoryEntry, "ownership" | "keep_reason"> {
  if (category === "memory") {
    return { ownership: "agmo-runtime", keep_reason: "memory is inspect-only" };
  }
  if (category === "state/team" || category === "worktrees") {
    return { ownership: "agmo-runtime", keep_reason: "lifecycle cleanup required" };
  }
  return { ownership: "agmo-known", keep_reason: "inspect-only slice does not delete files" };
}

export async function collectCleanupInventory(
  projectRoot = process.cwd()
): Promise<CleanupInventorySummary> {
  const paths = resolveInstallPaths("project", projectRoot);
  const policy = await resolveCleanupPolicy(projectRoot);
  const launchRecords = await listLaunchWorkspaces({ projectRoot });
  const worktreeSummary = await inspectTeamWorktrees(projectRoot);
  const entries: CleanupInventoryEntry[] = [];

  for (const categoryPath of CATEGORY_PATHS) {
    const root = join(paths.agmoDir, ...categoryPath.parts);
    for (const path of await listCategoryEntries(root)) {
      const measured = await measurePath(path);
      const categorySpecific =
        categoryPath.category === "cache/launch-workspaces"
          ? await launchWorkspaceDetails(path, launchRecords)
          : categoryPath.category === "worktrees"
            ? worktreeDetails(path, worktreeSummary)
            : defaultDetails(categoryPath.category);

      entries.push({
        category: categoryPath.category,
        path,
        relative_path: relativePath(projectRoot, path),
        bytes: measured.bytes,
        mtime_ms: measured.mtime_ms,
        kind: measured.kind,
        cleanup_eligible: false,
        ...categorySpecific
      });
    }
  }

  const categories = CATEGORY_PATHS.map(({ category }) => {
    const categoryEntries = entries.filter((entry) => entry.category === category);
    return {
      category,
      entries: categoryEntries.length,
      bytes: categoryEntries.reduce((sum, entry) => sum + entry.bytes, 0),
      cleanup_candidate_entries: 0,
      cleanup_candidate_bytes: 0
    };
  });

  return {
    project_root: projectRoot,
    agmo_dir: paths.agmoDir,
    policy,
    totals: {
      entries: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      cleanup_candidate_entries: 0,
      cleanup_candidate_bytes: 0
    },
    categories,
    entries
  };
}
