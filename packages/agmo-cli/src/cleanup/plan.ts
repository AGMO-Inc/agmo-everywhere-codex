import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { collectCleanupInventory, type CleanupInventoryEntry } from "./inventory.js";

export type CleanupPlanOptions = {
  olderThanDays?: number;
  maxBytes?: number;
  nowMs?: number;
};

export type CleanupPlanEntry = {
  category: CleanupInventoryEntry["category"];
  path: string;
  relative_path: string;
  bytes: number;
  mtime_ms: number | null;
  kind: CleanupInventoryEntry["kind"];
  reason: string;
  details?: Record<string, unknown>;
};

export type CleanupPlanSummary = {
  project_root: string;
  agmo_dir: string;
  policy: Awaited<ReturnType<typeof collectCleanupInventory>>["policy"];
  options: {
    older_than_days: number | null;
    max_bytes: number | null;
  };
  totals: {
    inspected_entries: number;
    inspected_bytes: number;
    would_delete_entries: number;
    would_delete_bytes: number;
    kept_entries: number;
    kept_bytes: number;
    projected_bytes_after_delete: number;
  };
  would_delete: CleanupPlanEntry[];
  kept: CleanupPlanEntry[];
};

type Decision =
  | { action: "delete"; reason: string }
  | { action: "keep"; reason: string };

const DAY_MS = 24 * 60 * 60 * 1000;

function launchRetentionMtimeMs(entry: CleanupInventoryEntry): number | null {
  const value = entry.details?.retention_mtime_ms;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ageMs(entry: CleanupInventoryEntry, nowMs: number, mtimeMs = entry.mtime_ms): number | null {
  return mtimeMs === null ? null : Math.max(nowMs - mtimeMs, 0);
}

function isOlderThan(
  entry: CleanupInventoryEntry,
  olderThanDays: number,
  nowMs: number,
  mtimeMs = entry.mtime_ms
): boolean {
  const age = ageMs(entry, nowMs, mtimeMs);
  return age !== null && age >= olderThanDays * DAY_MS;
}

function ttlDaysForEntry(entry: CleanupInventoryEntry, policy: CleanupPlanSummary["policy"]): number | null {
  switch (entry.category) {
    case "cache/session-instructions":
      return policy.policy.session_instructions_ttl_days;
    case "cache/launch-workspaces":
      return policy.policy.launch_workspace_ttl_hours / 24;
    case "state/sessions":
      return policy.policy.state_ttl_days;
    case "state/workflows":
      return policy.policy.workflow_state_ttl_days;
    case "logs":
      return policy.policy.cache_ttl_days;
    case "backups/setup":
      return policy.policy.cache_ttl_days;
    case "handoffs":
      return policy.policy.handoff_ttl_days;
    default:
      return null;
  }
}

function planEntry(entry: CleanupInventoryEntry, reason: string): CleanupPlanEntry {
  return {
    category: entry.category,
    path: entry.path,
    relative_path: entry.relative_path,
    bytes: entry.bytes,
    mtime_ms: entry.mtime_ms,
    kind: entry.kind,
    reason,
    ...(entry.details ? { details: entry.details } : {})
  };
}

function deterministicCompare(left: CleanupPlanEntry, right: CleanupPlanEntry): number {
  const category = left.category.localeCompare(right.category);
  if (category !== 0) {
    return category;
  }

  const leftTime = left.mtime_ms ?? Number.POSITIVE_INFINITY;
  const rightTime = right.mtime_ms ?? Number.POSITIVE_INFINITY;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return left.relative_path.localeCompare(right.relative_path);
}

function deletionOrder(left: CleanupInventoryEntry, right: CleanupInventoryEntry): number {
  const leftTtl = left.mtime_ms ?? Number.POSITIVE_INFINITY;
  const rightTtl = right.mtime_ms ?? Number.POSITIVE_INFINITY;
  if (leftTtl !== rightTtl) {
    return leftTtl - rightTtl;
  }

  const category = left.category.localeCompare(right.category);
  if (category !== 0) {
    return category;
  }

  return left.relative_path.localeCompare(right.relative_path);
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

async function canonicalPathVariants(path: string): Promise<string[]> {
  const resolved = resolve(path);
  try {
    const real = await realpath(path);
    return real === resolved ? [resolved] : [resolved, real];
  } catch {
    return [resolved];
  }
}

function stateLooksInactive(record: Record<string, unknown>): boolean {
  if (record.active === true) {
    return false;
  }
  if (record.active === false) {
    return true;
  }

  const status = typeof record.status === "string" ? record.status : undefined;
  const state = typeof record.state === "string" ? record.state : undefined;
  const workflowStatus =
    typeof record.workflow_status === "string" ? record.workflow_status : undefined;
  const values = [status, state, workflowStatus].filter((value): value is string => Boolean(value));

  return values.some((value) =>
    ["inactive", "completed", "complete", "stopped", "failed", "cancelled", "canceled"].includes(
      value
    )
  );
}

function hasAgmoStateShape(record: Record<string, unknown>): boolean {
  return (
    record.version === 1 &&
    typeof record.session_id === "string" &&
    record.session_id.trim().length > 0 &&
    typeof record.last_event === "string" &&
    record.last_event.trim().length > 0 &&
    typeof record.updated_at === "string" &&
    record.updated_at.trim().length > 0
  );
}

function launchWorkspaceDecision(entry: CleanupInventoryEntry, eligibleByAge: boolean): Decision {
  const details = entry.details ?? {};
  if (details.derived_state === "active") {
    return { action: "keep", reason: "active launch workspace" };
  }
  if (details.dirty_state === "dirty") {
    return { action: "keep", reason: "dirty launch workspace" };
  }
  if (details.dirty_state !== "clean") {
    return { action: "keep", reason: "unknown launch workspace dirty state" };
  }
  if (details.derived_state !== "inactive" && details.derived_state !== "stale") {
    return { action: "keep", reason: "unknown launch workspace state" };
  }
  if (!eligibleByAge) {
    return { action: "keep", reason: "launch workspace newer than retention threshold" };
  }
  return { action: "delete", reason: "inactive clean launch workspace older than retention threshold" };
}

async function stateDecision(entry: CleanupInventoryEntry, eligibleByAge: boolean): Promise<Decision> {
  const record = await readJsonObject(entry.path);
  if (!record) {
    return { action: "keep", reason: "malformed state file kept for manual review" };
  }
  if (!hasAgmoStateShape(record)) {
    return { action: "keep", reason: "state file lacks Agmo runtime shape evidence" };
  }
  if (!stateLooksInactive(record)) {
    return { action: "keep", reason: "state file lacks explicit inactive evidence" };
  }
  if (!eligibleByAge) {
    return { action: "keep", reason: "state file newer than retention threshold" };
  }
  return { action: "delete", reason: "inactive state file older than retention threshold" };
}

async function isMachineGeneratedHandoff(entry: CleanupInventoryEntry): Promise<boolean> {
  const content = await readFile(entry.path, "utf8").catch(() => "");
  return content.includes("AGMO") || content.includes("Agmo") || basename(entry.path).startsWith("handoff-");
}

async function baseDecision(
  entry: CleanupInventoryEntry,
  policy: CleanupPlanSummary["policy"],
  olderThanDays: number | undefined,
  nowMs: number,
  latestSetupBackupPath: string | null,
  protectedLaunchSessionIds: Set<string>,
  protectedSessionInstructionDirs: Set<string>
): Promise<Decision> {
  if (entry.kind === "symlink") {
    return { action: "keep", reason: "symlink kept for manual review" };
  }
  if (entry.kind === "missing" || entry.kind === "unknown") {
    return { action: "keep", reason: "unknown entry kind kept for manual review" };
  }
  if (entry.ownership === "unknown" || entry.ownership === "manual-review") {
    return { action: "keep", reason: entry.keep_reason };
  }

  const ttlDays = olderThanDays ?? ttlDaysForEntry(entry, policy);
  const ageReferenceMs =
    entry.category === "cache/launch-workspaces"
      ? launchRetentionMtimeMs(entry)
      : entry.mtime_ms;
  const eligibleByAge = ttlDays !== null && isOlderThan(entry, ttlDays, nowMs, ageReferenceMs);

  switch (entry.category) {
    case "cache/session-instructions":
      const entryDirVariants = await canonicalPathVariants(entry.path);
      if (
        protectedLaunchSessionIds.has(basename(entry.path)) ||
        entryDirVariants.some((path) => protectedSessionInstructionDirs.has(path))
      ) {
        return { action: "keep", reason: "session instructions referenced by protected launch workspace" };
      }
      return eligibleByAge
        ? { action: "delete", reason: "session instructions older than retention threshold" }
        : { action: "keep", reason: "session instructions newer than retention threshold" };
    case "cache/launch-workspaces":
      return launchWorkspaceDecision(entry, eligibleByAge);
    case "state/sessions":
    case "state/workflows":
      return stateDecision(entry, eligibleByAge);
    case "logs":
      return eligibleByAge
        ? { action: "delete", reason: "Agmo log older than retention threshold" }
        : { action: "keep", reason: "Agmo log newer than retention threshold" };
    case "backups/setup":
      if (entry.path === latestSetupBackupPath) {
        return { action: "keep", reason: "latest setup backup kept" };
      }
      return eligibleByAge
        ? { action: "delete", reason: "Agmo setup backup older than retention threshold" }
        : { action: "keep", reason: "Agmo setup backup newer than retention threshold" };
    case "handoffs":
      if (!(await isMachineGeneratedHandoff(entry))) {
        return { action: "keep", reason: "handoff not clearly machine-generated" };
      }
      return eligibleByAge
        ? { action: "delete", reason: "machine-generated handoff older than retention threshold" }
        : { action: "keep", reason: "machine-generated handoff newer than retention threshold" };
    default:
      return { action: "keep", reason: entry.keep_reason };
  }
}

async function readLaunchComposedAgentsDirs(entry: CleanupInventoryEntry): Promise<string[]> {
  const detailsPath = entry.details?.composed_agents_path;
  if (typeof detailsPath === "string" && detailsPath.trim().length > 0) {
    return canonicalPathVariants(dirname(detailsPath));
  }

  const metadata = await readJsonObject(join(entry.path, "metadata.json"));
  const metadataPath = metadata?.composed_agents_path;
  return typeof metadataPath === "string" && metadataPath.trim().length > 0
    ? canonicalPathVariants(dirname(metadataPath))
    : [];
}

function isProtectedLaunchWorkspace(entry: CleanupInventoryEntry): boolean {
  const details = entry.details ?? {};
  return (
    details.derived_state === "active" ||
    details.derived_state === "unknown" ||
    details.dirty_state === "dirty" ||
    details.dirty_state === "unknown"
  );
}

function sizeCapDecision(
  keptEntry: CleanupPlanEntry,
  original: CleanupInventoryEntry
): Decision | null {
  if (
    keptEntry.kind === "symlink" ||
    original.ownership === "unknown" ||
    original.ownership === "manual-review"
  ) {
    return null;
  }

  switch (original.category) {
    case "cache/session-instructions":
      return keptEntry.reason === "session instructions newer than retention threshold"
        ? { action: "delete", reason: "selected by project size cap" }
        : null;
    case "logs":
      return keptEntry.reason === "Agmo log newer than retention threshold"
        ? { action: "delete", reason: "selected by project size cap" }
        : null;
    case "backups/setup":
      return keptEntry.reason === "Agmo setup backup newer than retention threshold"
        ? { action: "delete", reason: "selected by project size cap" }
        : null;
    default:
      return null;
  }
}

export async function createCleanupPlan(
  projectRoot = process.cwd(),
  options: CleanupPlanOptions = {}
): Promise<CleanupPlanSummary> {
  const inventory = await collectCleanupInventory(projectRoot);
  const nowMs = options.nowMs ?? Date.now();
  const initialWouldDelete: CleanupPlanEntry[] = [];
  const keptByPath = new Map<string, CleanupPlanEntry>();
  const originalsByPath = new Map<string, CleanupInventoryEntry>();
  const latestSetupBackupPath =
    inventory.entries
      .filter((entry) => entry.category === "backups/setup")
      .sort((left, right) => deletionOrder(right, left))[0]?.path ?? null;
  const protectedLaunchSessionIds = new Set(
    inventory.entries
      .filter((entry) => entry.category === "cache/launch-workspaces")
      .filter(isProtectedLaunchWorkspace)
      .map((entry) => entry.details?.session_id)
      .filter((sessionId): sessionId is string => typeof sessionId === "string" && sessionId.length > 0)
  );
  const protectedSessionInstructionDirs = new Set(
    (
      await Promise.all(
        inventory.entries
          .filter((entry) => entry.category === "cache/launch-workspaces")
          .filter(isProtectedLaunchWorkspace)
          .map((entry) => readLaunchComposedAgentsDirs(entry))
      )
    ).flat()
  );

  for (const entry of inventory.entries) {
    originalsByPath.set(entry.path, entry);
    const decision = await baseDecision(
      entry,
      inventory.policy,
      options.olderThanDays,
      nowMs,
      latestSetupBackupPath,
      protectedLaunchSessionIds,
      protectedSessionInstructionDirs
    );
    if (decision.action === "delete") {
      initialWouldDelete.push(planEntry(entry, decision.reason));
    } else {
      keptByPath.set(entry.path, planEntry(entry, decision.reason));
    }
  }

  const wouldDelete = [...initialWouldDelete];
  const maxBytes = options.maxBytes;
  if (typeof maxBytes === "number") {
    let projectedBytes =
      inventory.totals.bytes - wouldDelete.reduce((sum, entry) => sum + entry.bytes, 0);
    if (projectedBytes > maxBytes) {
      const sizeCapEligible = [...keptByPath.values()]
        .map((kept) => ({ kept, original: originalsByPath.get(kept.path) }))
        .filter((entry): entry is { kept: CleanupPlanEntry; original: CleanupInventoryEntry } =>
          Boolean(entry.original)
        )
        .sort((left, right) => deletionOrder(left.original, right.original));

      for (const { kept, original } of sizeCapEligible) {
        if (projectedBytes <= maxBytes) {
          break;
        }
        const decision = sizeCapDecision(kept, original);
        if (!decision) {
          continue;
        }
        keptByPath.delete(kept.path);
        wouldDelete.push(planEntry(original, decision.reason));
        projectedBytes -= original.bytes;
      }
    }
  }

  const kept = [...keptByPath.values()].sort(deterministicCompare);
  const sortedWouldDelete = wouldDelete.sort(deterministicCompare);
  const wouldDeleteBytes = sortedWouldDelete.reduce((sum, entry) => sum + entry.bytes, 0);
  const keptBytes = kept.reduce((sum, entry) => sum + entry.bytes, 0);

  return {
    project_root: inventory.project_root,
    agmo_dir: inventory.agmo_dir,
    policy: inventory.policy,
    options: {
      older_than_days: options.olderThanDays ?? null,
      max_bytes: options.maxBytes ?? null
    },
    totals: {
      inspected_entries: inventory.totals.entries,
      inspected_bytes: inventory.totals.bytes,
      would_delete_entries: sortedWouldDelete.length,
      would_delete_bytes: wouldDeleteBytes,
      kept_entries: kept.length,
      kept_bytes: keptBytes,
      projected_bytes_after_delete: inventory.totals.bytes - wouldDeleteBytes
    },
    would_delete: sortedWouldDelete,
    kept
  };
}
