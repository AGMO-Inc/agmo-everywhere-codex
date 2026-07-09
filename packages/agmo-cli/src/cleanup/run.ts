import { lstat, realpath, rm, unlink } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { createCleanupPlan, type CleanupPlanEntry, type CleanupPlanOptions } from "./plan.js";

export type CleanupRunOptions = CleanupPlanOptions;

export type CleanupRunRemovedEntry = {
  path: string;
  relative_path: string;
  category: CleanupPlanEntry["category"];
  bytes: number;
  reason: string;
  kind: CleanupPlanEntry["kind"];
};

export type CleanupRunSkippedEntry = CleanupRunRemovedEntry & {
  skipped_reason: string;
};

export type CleanupRunFailureEntry = CleanupRunRemovedEntry & {
  error: string;
};

export type CleanupRunSummary = Awaited<ReturnType<typeof createCleanupPlan>> & {
  run: {
    removed: CleanupRunRemovedEntry[];
    skipped: CleanupRunSkippedEntry[];
    failures: CleanupRunFailureEntry[];
    totals: {
      planned_entries: number;
      planned_bytes: number;
      removed_entries: number;
      removed_bytes: number;
      skipped_entries: number;
      failure_entries: number;
    };
  };
};

const DELETABLE_CATEGORIES = new Set<CleanupPlanEntry["category"]>([
  "cache/session-instructions",
  "cache/launch-workspaces",
  "state/sessions",
  "state/workflows",
  "logs",
  "backups/setup",
  "handoffs"
]);

function pathIsInside(parent: string, child: string): boolean {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  const childRelative = relative(parentPath, childPath);
  return childRelative === "" || (!childRelative.startsWith("..") && !childRelative.includes(`..${sep}`));
}

function ledgerBase(entry: CleanupPlanEntry): CleanupRunRemovedEntry {
  return {
    path: entry.path,
    relative_path: entry.relative_path,
    category: entry.category,
    bytes: entry.bytes,
    reason: entry.reason,
    kind: entry.kind
  };
}

function kindFromStats(stats: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): CleanupPlanEntry["kind"] {
  if (stats.isSymbolicLink()) {
    return "symlink";
  }
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isFile()) {
    return "file";
  }
  return "unknown";
}

function expectedCategoryPrefix(category: CleanupPlanEntry["category"]): string {
  return `.agmo/${category}/`;
}

function relativePathStillMatchesCategory(entry: CleanupPlanEntry): boolean {
  return (
    entry.relative_path === `.agmo/${entry.category}` ||
    entry.relative_path.startsWith(expectedCategoryPrefix(entry.category))
  );
}

function actualPathStillMatchesCategory(agmoDir: string, entry: CleanupPlanEntry): boolean {
  const categoryRelativePath = relative(resolve(agmoDir), resolve(entry.path));
  return (
    categoryRelativePath === entry.category ||
    categoryRelativePath.startsWith(`${entry.category}/`) ||
    categoryRelativePath.startsWith(`${entry.category}${sep}`)
  );
}

function skip(entry: CleanupPlanEntry, skipped_reason: string): CleanupRunSkippedEntry {
  return { ...ledgerBase(entry), skipped_reason };
}

function failure(entry: CleanupPlanEntry, error: unknown): CleanupRunFailureEntry {
  const message = error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
  return { ...ledgerBase(entry), error: message };
}

async function deletePlannedEntry(
  agmoDir: string,
  realAgmoDir: string,
  entry: CleanupPlanEntry
): Promise<
  | { status: "removed"; entry: CleanupRunRemovedEntry }
  | { status: "skipped"; entry: CleanupRunSkippedEntry }
  | { status: "failure"; entry: CleanupRunFailureEntry }
> {
  if (!DELETABLE_CATEGORIES.has(entry.category)) {
    return { status: "skipped", entry: skip(entry, "category is not deletable by cleanup run") };
  }
  if (!relativePathStillMatchesCategory(entry)) {
    return { status: "skipped", entry: skip(entry, "planned path no longer matches planned category") };
  }
  if (!actualPathStillMatchesCategory(agmoDir, entry)) {
    return { status: "skipped", entry: skip(entry, "planned absolute path no longer matches planned category") };
  }
  if (!pathIsInside(agmoDir, entry.path)) {
    return { status: "skipped", entry: skip(entry, "planned path is outside project .agmo directory") };
  }

  let stats;
  try {
    stats = await lstat(entry.path);
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT") {
      return { status: "skipped", entry: skip(entry, "already_missing") };
    }
    return { status: "failure", entry: failure(entry, error) };
  }

  const currentKind = kindFromStats(stats);
  if (currentKind === "symlink") {
    return { status: "skipped", entry: skip(entry, "planned path is now a symlink") };
  }
  if (currentKind !== entry.kind) {
    return { status: "skipped", entry: skip(entry, `planned kind ${entry.kind} changed to ${currentKind}`) };
  }
  if (currentKind !== "file" && currentKind !== "directory") {
    return { status: "skipped", entry: skip(entry, "planned path kind is not safely deletable") };
  }

  let realEntryPath;
  try {
    realEntryPath = await realpath(entry.path);
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT") {
      return { status: "skipped", entry: skip(entry, "already_missing") };
    }
    return { status: "failure", entry: failure(entry, error) };
  }
  if (!pathIsInside(realAgmoDir, realEntryPath)) {
    return { status: "skipped", entry: skip(entry, "planned path realpath is outside project .agmo directory") };
  }

  try {
    if (currentKind === "directory") {
      await rm(entry.path, { recursive: true, force: false });
    } else {
      await unlink(entry.path);
    }
    return { status: "removed", entry: ledgerBase(entry) };
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT") {
      return { status: "skipped", entry: skip(entry, "already_missing") };
    }
    return { status: "failure", entry: failure(entry, error) };
  }
}

export async function runCleanup(
  projectRoot = process.cwd(),
  options: CleanupRunOptions = {}
): Promise<CleanupRunSummary> {
  const plan = await createCleanupPlan(projectRoot, options);
  return runCleanupPlan(plan);
}

export async function runCleanupPlan(
  plan: Awaited<ReturnType<typeof createCleanupPlan>>
): Promise<CleanupRunSummary> {
  const realAgmoDir = await realpath(plan.agmo_dir).catch(() => resolve(plan.agmo_dir));
  const removed: CleanupRunRemovedEntry[] = [];
  const skipped: CleanupRunSkippedEntry[] = [];
  const failures: CleanupRunFailureEntry[] = [];

  for (const plannedEntry of plan.would_delete) {
    const result = await deletePlannedEntry(plan.agmo_dir, realAgmoDir, plannedEntry);
    if (result.status === "removed") {
      removed.push(result.entry);
    } else if (result.status === "skipped") {
      skipped.push(result.entry);
    } else {
      failures.push(result.entry);
    }
  }

  return {
    ...plan,
    run: {
      removed,
      skipped,
      failures,
      totals: {
        planned_entries: plan.would_delete.length,
        planned_bytes: plan.would_delete.reduce((sum, entry) => sum + entry.bytes, 0),
        removed_entries: removed.length,
        removed_bytes: removed.reduce((sum, entry) => sum + entry.bytes, 0),
        skipped_entries: skipped.length,
        failure_entries: failures.length
      }
    }
  };
}
