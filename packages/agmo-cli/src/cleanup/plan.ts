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
  effective_caps: CleanupEffectiveCaps;
  pressure: CleanupPressure;
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

export const CLEANUP_CAP_REASONS = {
  launchWorkspaceBytes: "selected by launch workspace byte cap",
  stateFileCount: "selected by state file count cap",
  projectBytes: "selected by project size cap"
} as const;

export type CleanupCapReason = (typeof CLEANUP_CAP_REASONS)[keyof typeof CLEANUP_CAP_REASONS];

export type CleanupEffectiveCaps = {
  max_launch_workspace_bytes: {
    configured: number;
    enabled: boolean;
    effective: number | null;
  };
  max_state_files: {
    configured: number;
    enabled: boolean;
    effective: number | null;
  };
  max_project_agmo_bytes: {
    configured: number;
    enabled: boolean;
    explicit_override: number | null;
    effective: number | null;
  };
};

export type CleanupPressure = {
  launch_workspace_bytes: ByteCapPressure;
  state_files: StateFileCapPressure;
  project_bytes: ByteCapPressure;
};

export type ByteCapPressure = {
  target: number | null;
  before_bytes: number;
  after_bytes: number;
  selected_entries: number;
  selected_bytes: number;
  skipped_ineligible_entries: number;
  skipped_ineligible_bytes: number;
  reachable: boolean;
  unreachable_reason: string | null;
};

export type StateFileCapPressure = {
  target: number | null;
  before_count: number;
  after_count: number;
  selected_entries: number;
  pairs_selected: number;
  skipped_ineligible_entries: number;
  reachable: boolean;
  unreachable_reason: string | null;
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

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isSafeSessionId(sessionId: unknown): sessionId is string {
  return (
    typeof sessionId === "string" &&
    sessionId.length > 0 &&
    sessionId !== "." &&
    sessionId !== ".." &&
    basename(sessionId) === sessionId &&
    !sessionId.includes("/") &&
    !sessionId.includes("\\")
  );
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

type StateFileFacts = {
  valid_shape: boolean;
  inactive: boolean;
  session_id: string | null;
  mtime_ms: number | null;
};

async function stateFileFacts(entry: CleanupInventoryEntry): Promise<StateFileFacts> {
  const record = await readJsonObject(entry.path);
  if (!record) {
    return { valid_shape: false, inactive: false, session_id: null, mtime_ms: entry.mtime_ms };
  }
  return {
    valid_shape: hasAgmoStateShape(record),
    inactive: stateLooksInactive(record),
    session_id: stringValue(record.session_id),
    mtime_ms: entry.mtime_ms
  };
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

function isLaunchWorkspaceCapEligible(entry: CleanupInventoryEntry, keptEntry: CleanupPlanEntry): boolean {
  const details = entry.details ?? {};
  return (
    entry.category === "cache/launch-workspaces" &&
    entry.kind === "directory" &&
    entry.ownership === "agmo-runtime" &&
    keptEntry.reason === "launch workspace newer than retention threshold" &&
    (details.derived_state === "inactive" || details.derived_state === "stale") &&
    details.dirty_state === "clean" &&
    typeof details.retention_mtime_ms === "number" &&
    Number.isFinite(details.retention_mtime_ms) &&
    isSafeSessionId(details.session_id)
  );
}

function launchWorkspaceCapCompare(
  left: { kept: CleanupPlanEntry; original: CleanupInventoryEntry },
  right: { kept: CleanupPlanEntry; original: CleanupInventoryEntry }
): number {
  const leftTime = launchRetentionMtimeMs(left.original) ?? Number.POSITIVE_INFINITY;
  const rightTime = launchRetentionMtimeMs(right.original) ?? Number.POSITIVE_INFINITY;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.kept.relative_path.localeCompare(right.kept.relative_path);
}

function projectCapDecision(
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
        ? { action: "delete", reason: CLEANUP_CAP_REASONS.projectBytes }
        : null;
    case "cache/launch-workspaces":
      return isLaunchWorkspaceCapEligible(original, keptEntry)
        ? { action: "delete", reason: CLEANUP_CAP_REASONS.projectBytes }
        : null;
    case "state/sessions":
    case "state/workflows":
      return keptEntry.reason === "state file newer than retention threshold"
        ? { action: "delete", reason: CLEANUP_CAP_REASONS.projectBytes }
        : null;
    case "logs":
      return keptEntry.reason === "Agmo log newer than retention threshold"
        ? { action: "delete", reason: CLEANUP_CAP_REASONS.projectBytes }
        : null;
    case "backups/setup":
      return keptEntry.reason === "Agmo setup backup newer than retention threshold"
        ? { action: "delete", reason: CLEANUP_CAP_REASONS.projectBytes }
        : null;
    case "handoffs":
      return keptEntry.reason === "machine-generated handoff newer than retention threshold"
        ? { action: "delete", reason: CLEANUP_CAP_REASONS.projectBytes }
        : null;
    default:
      return null;
  }
}

function bytePressure(args: {
  target: number | null;
  beforeBytes: number;
  afterBytes: number;
  selectedEntries: number;
  selectedBytes: number;
  skippedIneligibleEntries: number;
  skippedIneligibleBytes: number;
}): ByteCapPressure {
  const reachable = args.target === null || args.afterBytes <= args.target;
  return {
    target: args.target,
    before_bytes: args.beforeBytes,
    after_bytes: args.afterBytes,
    selected_entries: args.selectedEntries,
    selected_bytes: args.selectedBytes,
    skipped_ineligible_entries: args.skippedIneligibleEntries,
    skipped_ineligible_bytes: args.skippedIneligibleBytes,
    reachable,
    unreachable_reason: reachable ? null : "no eligible entries remain before cap target"
  };
}

function statePressure(args: {
  target: number | null;
  beforeCount: number;
  afterCount: number;
  selectedEntries: number;
  pairsSelected: number;
  skippedIneligibleEntries: number;
}): StateFileCapPressure {
  const reachable = args.target === null || args.afterCount <= args.target;
  return {
    target: args.target,
    before_count: args.beforeCount,
    after_count: args.afterCount,
    selected_entries: args.selectedEntries,
    pairs_selected: args.pairsSelected,
    skipped_ineligible_entries: args.skippedIneligibleEntries,
    reachable,
    unreachable_reason: reachable ? null : "no eligible entries remain before cap target"
  };
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

  const configuredLaunchCap = inventory.policy.policy.max_launch_workspace_bytes;
  const configuredStateCap = inventory.policy.policy.max_state_files;
  const configuredProjectCap = inventory.policy.policy.max_project_agmo_bytes;
  const effectiveCaps: CleanupEffectiveCaps = {
    max_launch_workspace_bytes: {
      configured: configuredLaunchCap,
      enabled: configuredLaunchCap > 0,
      effective: configuredLaunchCap > 0 ? configuredLaunchCap : null
    },
    max_state_files: {
      configured: configuredStateCap,
      enabled: configuredStateCap > 0,
      effective: configuredStateCap > 0 ? configuredStateCap : null
    },
    max_project_agmo_bytes: {
      configured: configuredProjectCap,
      enabled: options.maxBytes !== undefined || configuredProjectCap > 0,
      explicit_override: options.maxBytes ?? null,
      effective: options.maxBytes ?? (configuredProjectCap > 0 ? configuredProjectCap : null)
    }
  };

  const wouldDelete = [...initialWouldDelete];
  let projectedBytes =
    inventory.totals.bytes - wouldDelete.reduce((sum, entry) => sum + entry.bytes, 0);

  const launchTarget = effectiveCaps.max_launch_workspace_bytes.effective;
  const retainedLaunchBytes = () =>
    [...keptByPath.values()]
      .filter((entry) => entry.category === "cache/launch-workspaces")
      .reduce((sum, entry) => sum + entry.bytes, 0);
  const launchBeforeBytes = retainedLaunchBytes();
  let launchSelectedEntries = 0;
  let launchSelectedBytes = 0;
  if (launchTarget !== null && launchBeforeBytes > launchTarget) {
    let retainedBytes = launchBeforeBytes;
    const launchCandidates = [...keptByPath.values()]
      .map((kept) => ({ kept, original: originalsByPath.get(kept.path) }))
      .filter((entry): entry is { kept: CleanupPlanEntry; original: CleanupInventoryEntry } => {
        if (!entry.original) {
          return false;
        }
        return isLaunchWorkspaceCapEligible(entry.original, entry.kept);
      })
      .sort(launchWorkspaceCapCompare);

    for (const { kept, original } of launchCandidates) {
      if (retainedBytes <= launchTarget) {
        break;
      }
      keptByPath.delete(kept.path);
      wouldDelete.push(planEntry(original, CLEANUP_CAP_REASONS.launchWorkspaceBytes));
      retainedBytes -= original.bytes;
      projectedBytes -= original.bytes;
      launchSelectedEntries += 1;
      launchSelectedBytes += original.bytes;
    }
  }
  const launchAfterBytes = retainedLaunchBytes();
  const retainedLaunchIneligible = [...keptByPath.values()]
    .filter((kept) => kept.category === "cache/launch-workspaces")
    .map((kept) => ({ kept, original: originalsByPath.get(kept.path) }))
    .filter((entry) => {
      if (!entry.original) {
        return false;
      }
      return !isLaunchWorkspaceCapEligible(entry.original, entry.kept);
    });
  const launchPressure = bytePressure({
    target: launchTarget,
    beforeBytes: launchBeforeBytes,
    afterBytes: launchAfterBytes,
    selectedEntries: launchSelectedEntries,
    selectedBytes: launchSelectedBytes,
    skippedIneligibleEntries: retainedLaunchIneligible.length,
    skippedIneligibleBytes: retainedLaunchIneligible.reduce((sum, entry) => sum + entry.kept.bytes, 0)
  });

  const stateTarget = effectiveCaps.max_state_files.effective;
  const retainedStateEntries = () =>
    [...keptByPath.values()].filter(
      (entry) => entry.category === "state/sessions" || entry.category === "state/workflows"
    );
  let stateFactsByPath = new Map<string, StateFileFacts>();
  async function factsFor(entry: CleanupPlanEntry): Promise<StateFileFacts> {
    const existing = stateFactsByPath.get(entry.path);
    if (existing) {
      return existing;
    }
    const original = originalsByPath.get(entry.path);
    const facts = original
      ? await stateFileFacts(original)
      : { valid_shape: false, inactive: false, session_id: null, mtime_ms: entry.mtime_ms };
    stateFactsByPath.set(entry.path, facts);
    return facts;
  }
  const beforeStateEntries = retainedStateEntries();
  const beforeStateFacts = await Promise.all(beforeStateEntries.map(async (entry) => ({ entry, facts: await factsFor(entry) })));
  const validInactiveState = beforeStateFacts.filter(
    ({ facts }) => facts.valid_shape && facts.inactive && facts.session_id
  );
  const stateBeforeCount = validInactiveState.length;
  let stateSelectedEntries = 0;
  let statePairsSelected = 0;
  if (stateTarget !== null && stateBeforeCount > stateTarget) {
    const groups = new Map<string, Array<{ entry: CleanupPlanEntry; facts: StateFileFacts }>>();
    for (const item of validInactiveState) {
      if (item.entry.reason !== "state file newer than retention threshold") {
        continue;
      }
      const key = item.facts.session_id
        ? `session:${item.facts.session_id}`
        : `${item.entry.category}:${item.entry.relative_path}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    const orderedGroups = [...groups.entries()]
      .map(([key, members]) => ({ key, members }))
      .sort((left, right) => {
        const leftTime = Math.min(...left.members.map((member) => member.facts.mtime_ms ?? Number.POSITIVE_INFINITY));
        const rightTime = Math.min(...right.members.map((member) => member.facts.mtime_ms ?? Number.POSITIVE_INFINITY));
        if (leftTime !== rightTime) {
          return leftTime - rightTime;
        }
        const keyCompare = left.key.localeCompare(right.key);
        if (keyCompare !== 0) {
          return keyCompare;
        }
        return left.members[0]!.entry.relative_path.localeCompare(right.members[0]!.entry.relative_path);
      });
    let retainedCount = stateBeforeCount;
    for (const group of orderedGroups) {
      if (retainedCount <= stateTarget) {
        break;
      }
      statePairsSelected += 1;
      for (const member of group.members.sort((left, right) => left.entry.relative_path.localeCompare(right.entry.relative_path))) {
        if (!keptByPath.has(member.entry.path)) {
          continue;
        }
        const original = originalsByPath.get(member.entry.path);
        if (!original) {
          continue;
        }
        keptByPath.delete(member.entry.path);
        wouldDelete.push(planEntry(original, CLEANUP_CAP_REASONS.stateFileCount));
        projectedBytes -= original.bytes;
        retainedCount -= 1;
        stateSelectedEntries += 1;
      }
    }
  }
  const afterStateEntries = retainedStateEntries();
  const afterStateFacts = await Promise.all(afterStateEntries.map(async (entry) => ({ entry, facts: await factsFor(entry) })));
  const stateAfterCount = afterStateFacts.filter(
    ({ facts }) => facts.valid_shape && facts.inactive && facts.session_id
  ).length;
  const statePressureSummary = statePressure({
    target: stateTarget,
    beforeCount: stateBeforeCount,
    afterCount: stateAfterCount,
    selectedEntries: stateSelectedEntries,
    pairsSelected: statePairsSelected,
    skippedIneligibleEntries: afterStateEntries.length - stateAfterCount
  });

  const projectTarget = effectiveCaps.max_project_agmo_bytes.effective;
  const projectBeforeBytes = projectedBytes;
  let projectSelectedEntries = 0;
  let projectSelectedBytes = 0;
  if (projectTarget !== null && projectedBytes > projectTarget) {
    const projectCandidates = [...keptByPath.values()]
      .map((kept) => ({ kept, original: originalsByPath.get(kept.path) }))
      .filter((entry): entry is { kept: CleanupPlanEntry; original: CleanupInventoryEntry } =>
        Boolean(entry.original)
      )
      .sort((left, right) => deletionOrder(left.original, right.original));

    for (const { kept, original } of projectCandidates) {
      if (projectedBytes <= projectTarget) {
        break;
      }
      const decision = projectCapDecision(kept, original);
      if (!decision) {
        continue;
      }
      keptByPath.delete(kept.path);
      wouldDelete.push(planEntry(original, decision.reason));
      projectedBytes -= original.bytes;
      projectSelectedEntries += 1;
      projectSelectedBytes += original.bytes;
    }
  }
  const projectAfterBytes = projectedBytes;
  const retainedProjectIneligible = [...keptByPath.values()]
    .map((kept) => ({ kept, original: originalsByPath.get(kept.path) }))
    .filter((entry) => !entry.original || projectCapDecision(entry.kept, entry.original) === null);
  const pressure: CleanupPressure = {
    launch_workspace_bytes: launchPressure,
    state_files: statePressureSummary,
    project_bytes: bytePressure({
      target: projectTarget,
      beforeBytes: projectBeforeBytes,
      afterBytes: projectAfterBytes,
      selectedEntries: projectSelectedEntries,
      selectedBytes: projectSelectedBytes,
      skippedIneligibleEntries: retainedProjectIneligible.length,
      skippedIneligibleBytes: retainedProjectIneligible.reduce((sum, entry) => sum + entry.kept.bytes, 0)
    })
  };

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
    effective_caps: effectiveCaps,
    pressure,
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
