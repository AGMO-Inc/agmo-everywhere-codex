import { existsSync } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  collectCleanupInventory,
  type CleanupInventoryCategory,
  type CleanupInventorySummary
} from "./inventory.js";
import { readTextFileIfExists, writeJsonFile } from "../utils/fs.js";
import { resolveInstallPaths } from "../utils/paths.js";

export type CleanupProjectRegistryEntry = {
  project_root: string;
  agmo_dir: string;
  discovered_at: string;
  updated_at: string;
  source: "discover";
};

export type CleanupProjectRegistry = {
  version: 1;
  updated_at: string;
  projects: CleanupProjectRegistryEntry[];
};

export type CleanupProjectStatus = CleanupProjectRegistryEntry & {
  status: "available" | "skipped";
  skip_reason?: string;
};

export type CleanupProjectDiscoverySkipped = {
  path: string;
  reason: string;
};

export type CleanupProjectDiscoveryResult = {
  registry_path: string;
  root: string;
  max_depth: number;
  discovered: CleanupProjectRegistryEntry[];
  skipped: CleanupProjectDiscoverySkipped[];
  registry: CleanupProjectRegistry;
};

export type CleanupAllProjectsInspectResult = {
  registry_path: string;
  totals: {
    projects: number;
    skipped_projects: number;
    entries: number;
    bytes: number;
    cleanup_candidate_entries: number;
    cleanup_candidate_bytes: number;
  };
  categories: CleanupInventorySummary["categories"];
  projects: Array<{
    project_root: string;
    agmo_dir: string;
    totals: CleanupInventorySummary["totals"];
    categories: CleanupInventorySummary["categories"];
    entries?: CleanupInventorySummary["entries"];
  }>;
  skipped: Array<{
    project_root: string;
    agmo_dir: string;
    reason: string;
  }>;
};

const REGISTRY_VERSION = 1;
const DISCOVERY_IGNORED_DIRS = new Set([
  ".agmo",
  ".cache",
  ".git",
  ".hg",
  ".pnpm",
  ".pnpm-store",
  ".svn",
  ".yarn",
  "_cacache",
  "cache",
  "dist",
  "build",
  "coverage",
  "node_modules"
]);

function registryPath(cwd = process.cwd()): string {
  return join(resolveInstallPaths("user", cwd).stateDir, "cleanup", "projects.json");
}

function nowIso(): string {
  return new Date().toISOString();
}

function isPathWithin(parent: string, child: string): boolean {
  const pathRelative = relative(resolve(parent), resolve(child));
  return pathRelative === "" || (pathRelative.length > 0 && !pathRelative.startsWith("..") && !isAbsolute(pathRelative));
}

async function readJsonObject<T>(path: string): Promise<T | null> {
  const content = await readTextFileIfExists(path);
  if (!content) {
    return null;
  }

  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export async function readCleanupProjectRegistry(cwd = process.cwd()): Promise<{
  path: string;
  registry: CleanupProjectRegistry;
}> {
  const path = registryPath(cwd);
  const parsed = await readJsonObject<Partial<CleanupProjectRegistry>>(path);
  const projects = Array.isArray(parsed?.projects)
    ? parsed.projects.filter(isRegistryEntry)
    : [];

  return {
    path,
    registry: {
      version: REGISTRY_VERSION,
      updated_at: typeof parsed?.updated_at === "string" ? parsed.updated_at : nowIso(),
      projects: projects.sort((left, right) => left.project_root.localeCompare(right.project_root))
    }
  };
}

async function writeCleanupProjectRegistry(
  path: string,
  projects: CleanupProjectRegistryEntry[]
): Promise<CleanupProjectRegistry> {
  const registry: CleanupProjectRegistry = {
    version: REGISTRY_VERSION,
    updated_at: nowIso(),
    projects: projects.sort((left, right) => left.project_root.localeCompare(right.project_root))
  };
  await writeJsonFile(path, registry);
  return registry;
}

function isRegistryEntry(value: unknown): value is CleanupProjectRegistryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Partial<CleanupProjectRegistryEntry>;
  return (
    typeof entry.project_root === "string" &&
    typeof entry.agmo_dir === "string" &&
    typeof entry.discovered_at === "string" &&
    typeof entry.updated_at === "string" &&
    entry.source === "discover"
  );
}

async function validateProjectRoot(projectRoot: string): Promise<
  | { ok: true; project_root: string; agmo_dir: string }
  | { ok: false; project_root: string; agmo_dir: string; reason: string }
> {
  const resolvedRoot = resolve(projectRoot);
  const agmoDir = join(resolvedRoot, ".agmo");
  let rootStats;
  try {
    rootStats = await lstat(resolvedRoot);
  } catch {
    return { ok: false, project_root: resolvedRoot, agmo_dir: agmoDir, reason: "project root missing" };
  }
  if (rootStats.isSymbolicLink()) {
    return { ok: false, project_root: resolvedRoot, agmo_dir: agmoDir, reason: "project root is a symlink" };
  }
  if (!rootStats.isDirectory()) {
    return { ok: false, project_root: resolvedRoot, agmo_dir: agmoDir, reason: "project root is not a directory" };
  }

  let agmoStats;
  try {
    agmoStats = await lstat(agmoDir);
  } catch {
    return { ok: false, project_root: resolvedRoot, agmo_dir: agmoDir, reason: "missing .agmo directory" };
  }
  if (agmoStats.isSymbolicLink()) {
    return { ok: false, project_root: resolvedRoot, agmo_dir: agmoDir, reason: ".agmo is a symlink" };
  }
  if (!agmoStats.isDirectory()) {
    return { ok: false, project_root: resolvedRoot, agmo_dir: agmoDir, reason: ".agmo is not a directory" };
  }

  const realRoot = await realpath(resolvedRoot);
  const realAgmoDir = await realpath(agmoDir);
  if (!isPathWithin(realRoot, realAgmoDir)) {
    return {
      ok: false,
      project_root: realRoot,
      agmo_dir: realAgmoDir,
      reason: ".agmo realpath escapes project root"
    };
  }
  if (!existsSync(join(realAgmoDir, "config.json")) && !existsSync(join(realAgmoDir, "state"))) {
    return {
      ok: false,
      project_root: realRoot,
      agmo_dir: realAgmoDir,
      reason: "missing Agmo ownership evidence"
    };
  }

  return { ok: true, project_root: realRoot, agmo_dir: realAgmoDir };
}

async function isCandidateProjectRoot(path: string): Promise<boolean> {
  const agmoDir = join(path, ".agmo");
  try {
    const stats = await lstat(agmoDir);
    return !stats.isSymbolicLink() && stats.isDirectory() &&
      (existsSync(join(agmoDir, "config.json")) || existsSync(join(agmoDir, "state")));
  } catch {
    return false;
  }
}

export async function listCleanupProjects(cwd = process.cwd()): Promise<{
  registry_path: string;
  projects: CleanupProjectStatus[];
}> {
  const { path, registry } = await readCleanupProjectRegistry(cwd);
  const projects = await Promise.all(
    registry.projects.map(async (entry) => {
      const validated = await validateProjectRoot(entry.project_root);
      if (!validated.ok) {
        return { ...entry, status: "skipped" as const, skip_reason: validated.reason };
      }
      return {
        ...entry,
        project_root: validated.project_root,
        agmo_dir: validated.agmo_dir,
        status: "available" as const
      };
    })
  );

  return {
    registry_path: path,
    projects: projects.sort((left, right) => left.project_root.localeCompare(right.project_root))
  };
}

export async function discoverCleanupProjects(args: {
  root: string;
  maxDepth: number;
  cwd?: string;
}): Promise<CleanupProjectDiscoveryResult> {
  const cwd = args.cwd ?? process.cwd();
  const maxDepth = Math.max(0, Math.floor(args.maxDepth));
  const root = resolve(args.root);
  const { path, registry } = await readCleanupProjectRegistry(cwd);
  const existing = new Map(registry.projects.map((entry) => [entry.project_root, entry]));
  const discovered = new Map<string, CleanupProjectRegistryEntry>();
  const skipped: CleanupProjectDiscoverySkipped[] = [];
  const seenDirs = new Set<string>();

  async function visit(dir: string, depth: number): Promise<void> {
    let stats;
    try {
      stats = await lstat(dir);
    } catch {
      skipped.push({ path: dir, reason: "unreadable directory" });
      return;
    }
    if (stats.isSymbolicLink()) {
      skipped.push({ path: dir, reason: "symlink skipped" });
      return;
    }
    if (!stats.isDirectory()) {
      return;
    }

    let realDir;
    try {
      realDir = await realpath(dir);
    } catch {
      skipped.push({ path: dir, reason: "unreadable realpath" });
      return;
    }
    if (seenDirs.has(realDir)) {
      return;
    }
    seenDirs.add(realDir);

    if (await isCandidateProjectRoot(realDir)) {
      const validated = await validateProjectRoot(realDir);
      if (validated.ok) {
        const previous = existing.get(validated.project_root);
        discovered.set(validated.project_root, {
          project_root: validated.project_root,
          agmo_dir: validated.agmo_dir,
          discovered_at: previous?.discovered_at ?? nowIso(),
          updated_at: nowIso(),
          source: "discover"
        });
      } else {
        skipped.push({ path: realDir, reason: validated.reason });
      }
    }

    if (depth >= maxDepth) {
      return;
    }

    let children;
    try {
      children = await readdir(realDir, { withFileTypes: true });
    } catch {
      skipped.push({ path: realDir, reason: "unreadable directory entries" });
      return;
    }
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (DISCOVERY_IGNORED_DIRS.has(child.name)) {
        continue;
      }
      const childPath = join(realDir, child.name);
      if (child.isSymbolicLink()) {
        skipped.push({ path: childPath, reason: "symlink skipped" });
        continue;
      }
      if (!child.isDirectory()) {
        continue;
      }
      await visit(childPath, depth + 1);
    }
  }

  await visit(root, 0);

  const merged = new Map(existing);
  for (const entry of discovered.values()) {
    merged.set(entry.project_root, entry);
  }
  const nextRegistry = await writeCleanupProjectRegistry(path, [...merged.values()]);

  return {
    registry_path: path,
    root,
    max_depth: maxDepth,
    discovered: [...discovered.values()].sort((left, right) => left.project_root.localeCompare(right.project_root)),
    skipped: skipped.sort((left, right) => left.path.localeCompare(right.path)),
    registry: nextRegistry
  };
}

function emptyCategoryTotals(): CleanupAllProjectsInspectResult["categories"] {
  const categories: CleanupInventoryCategory[] = [
    "state/sessions",
    "state/workflows",
    "state/team",
    "cache/launch-workspaces",
    "cache/session-instructions",
    "handoffs",
    "logs",
    "memory",
    "worktrees",
    "backups/setup"
  ];
  return categories.map((category) => ({
    category,
    entries: 0,
    bytes: 0,
    cleanup_candidate_entries: 0,
    cleanup_candidate_bytes: 0
  }));
}

export async function inspectAllCleanupProjects(args: {
  cwd?: string;
  verbose?: boolean;
} = {}): Promise<CleanupAllProjectsInspectResult> {
  const cwd = args.cwd ?? process.cwd();
  const { path, registry } = await readCleanupProjectRegistry(cwd);
  const projects: CleanupAllProjectsInspectResult["projects"] = [];
  const skipped: CleanupAllProjectsInspectResult["skipped"] = [];
  const categoryTotals = new Map(emptyCategoryTotals().map((entry) => [entry.category, { ...entry }]));

  for (const entry of registry.projects) {
    const validated = await validateProjectRoot(entry.project_root);
    if (!validated.ok) {
      skipped.push({
        project_root: validated.project_root,
        agmo_dir: validated.agmo_dir,
        reason: validated.reason
      });
      continue;
    }

    try {
      const inventory = await collectCleanupInventory(validated.project_root);
      projects.push({
        project_root: inventory.project_root,
        agmo_dir: inventory.agmo_dir,
        totals: inventory.totals,
        categories: inventory.categories,
        ...(args.verbose ? { entries: inventory.entries } : {})
      });
      for (const category of inventory.categories) {
        const total = categoryTotals.get(category.category);
        if (!total) {
          continue;
        }
        total.entries += category.entries;
        total.bytes += category.bytes;
        total.cleanup_candidate_entries += category.cleanup_candidate_entries;
        total.cleanup_candidate_bytes += category.cleanup_candidate_bytes;
      }
    } catch (error) {
      skipped.push({
        project_root: validated.project_root,
        agmo_dir: validated.agmo_dir,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  projects.sort((left, right) => {
    const bytes = right.totals.bytes - left.totals.bytes;
    return bytes !== 0 ? bytes : left.project_root.localeCompare(right.project_root);
  });
  skipped.sort((left, right) => left.project_root.localeCompare(right.project_root));

  return {
    registry_path: path,
    totals: {
      projects: projects.length,
      skipped_projects: skipped.length,
      entries: projects.reduce((sum, entry) => sum + entry.totals.entries, 0),
      bytes: projects.reduce((sum, entry) => sum + entry.totals.bytes, 0),
      cleanup_candidate_entries: projects.reduce((sum, entry) => sum + entry.totals.cleanup_candidate_entries, 0),
      cleanup_candidate_bytes: projects.reduce((sum, entry) => sum + entry.totals.cleanup_candidate_bytes, 0)
    },
    categories: [...categoryTotals.values()],
    projects,
    skipped
  };
}
