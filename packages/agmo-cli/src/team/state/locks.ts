import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveTeamDir } from "./index.js";

export const DEFAULT_TASK_CLAIM_LEASE_MS = 15 * 60 * 1000;

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 25;
const LOCK_METADATA_FILE = "metadata.json";

export type AgmoTeamStateLockRecoveredFrom =
  | {
      reason: "stale";
      metadata: AgmoTeamStateLockMetadata;
    }
  | {
      reason: "malformed";
      raw_metadata?: string;
      error: string;
    };

export type AgmoTeamStateLockMetadata = {
  lock_name: string;
  owner_id: string;
  operation: string;
  acquired_at: string;
  expires_at: string;
  stale_after_ms: number;
  pid?: number;
  recovered_from?: AgmoTeamStateLockRecoveredFrom;
};

export type AgmoTeamStateLockHandle = {
  lockName: string;
  lockPath: string;
  metadataPath: string;
  ownerId: string;
  metadata: AgmoTeamStateLockMetadata;
  release: () => Promise<void>;
};

export type AgmoTeamStateLockOptions = {
  timeoutMs?: number;
  staleAfterMs?: number;
  retryMs?: number;
  ownerId?: string;
};

type ExistingLockReadResult =
  | {
      kind: "missing";
    }
  | {
      kind: "valid";
      metadata: AgmoTeamStateLockMetadata;
      stale: boolean;
    }
  | {
      kind: "malformed";
      rawMetadata?: string;
      error: string;
    }
  | {
      kind: "initializing";
    };

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeLockName(lockName: string): string {
  const normalized = lockName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!normalized) {
    throw new Error("lock name is empty after sanitization");
  }

  return normalized;
}

export function resolveTeamStateLocksDir(
  teamName: string,
  cwd = process.cwd()
): string {
  return join(resolveTeamDir(teamName, cwd), ".locks");
}

export function resolveTeamStateLockPath(
  teamName: string,
  lockName: string,
  cwd = process.cwd()
): string {
  return join(resolveTeamStateLocksDir(teamName, cwd), sanitizeLockName(lockName));
}

function resolveLockMetadataPath(lockPath: string): string {
  return join(lockPath, LOCK_METADATA_FILE);
}

function parseLockMetadata(raw: string): AgmoTeamStateLockMetadata {
  const parsed = JSON.parse(raw) as Partial<AgmoTeamStateLockMetadata>;
  if (
    typeof parsed.lock_name !== "string" ||
    typeof parsed.owner_id !== "string" ||
    typeof parsed.operation !== "string" ||
    typeof parsed.acquired_at !== "string" ||
    typeof parsed.expires_at !== "string" ||
    typeof parsed.stale_after_ms !== "number"
  ) {
    throw new Error("lock metadata is missing required fields");
  }

  return parsed as AgmoTeamStateLockMetadata;
}

function isLockStale(metadata: AgmoTeamStateLockMetadata, nowMs = Date.now()): boolean {
  const expiresAtMs = Date.parse(metadata.expires_at);
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) {
    return true;
  }

  const acquiredAtMs = Date.parse(metadata.acquired_at);
  return (
    Number.isFinite(acquiredAtMs) &&
    acquiredAtMs + metadata.stale_after_ms <= nowMs
  );
}

async function readExistingLock(lockPath: string): Promise<ExistingLockReadResult> {
  try {
    await access(lockPath, constants.F_OK);
  } catch {
    return { kind: "missing" };
  }

  const metadataPath = resolveLockMetadataPath(lockPath);
  let rawMetadata: string;
  try {
    rawMetadata = await readFile(metadataPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs < 250) {
          return { kind: "initializing" };
        }
      } catch {
        return { kind: "missing" };
      }
    }
    return {
      kind: "malformed",
      error: error instanceof Error ? error.message : String(error)
    };
  }

  try {
    const metadata = parseLockMetadata(rawMetadata);
    return {
      kind: "valid",
      metadata,
      stale: isLockStale(metadata)
    };
  } catch (error) {
    try {
      const lockStat = await stat(lockPath);
      if (Date.now() - lockStat.mtimeMs < 250) {
        return { kind: "initializing" };
      }
    } catch {
      return { kind: "missing" };
    }
    return {
      kind: "malformed",
      rawMetadata,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function buildLockMetadata(
  lockName: string,
  ownerId: string,
  operation: string,
  staleAfterMs: number,
  recoveredFrom?: AgmoTeamStateLockRecoveredFrom
): AgmoTeamStateLockMetadata {
  const acquiredAtMs = Date.now();
  return {
    lock_name: lockName,
    owner_id: ownerId,
    operation,
    acquired_at: new Date(acquiredAtMs).toISOString(),
    expires_at: new Date(acquiredAtMs + staleAfterMs).toISOString(),
    stale_after_ms: staleAfterMs,
    pid: typeof process.pid === "number" ? process.pid : undefined,
    ...(recoveredFrom ? { recovered_from: recoveredFrom } : {})
  };
}

function buildLockTimeoutError(
  teamName: string,
  lockName: string,
  operation: string,
  existing: ExistingLockReadResult
): Error {
  const holder =
    existing.kind === "valid"
      ? ` holder=${existing.metadata.owner_id} holder_operation=${existing.metadata.operation} expires_at=${existing.metadata.expires_at}`
      : existing.kind === "initializing"
        ? " holder=initializing"
      : "";
  return new Error(
    `timed out waiting for team state lock "${lockName}" for team "${teamName}" while running "${operation}". Retry after the active operation finishes or remove the stale lock if the owner is gone.${holder}`
  );
}

export async function acquireTeamStateLock(
  teamName: string,
  lockName: string,
  operation: string,
  cwd = process.cwd(),
  options: AgmoTeamStateLockOptions = {}
): Promise<AgmoTeamStateLockHandle> {
  const normalizedLockName = sanitizeLockName(lockName);
  const lockPath = resolveTeamStateLockPath(teamName, normalizedLockName, cwd);
  const metadataPath = resolveLockMetadataPath(lockPath);
  const ownerId = options.ownerId ?? randomUUID();
  const timeoutMs = Math.max(options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, 0);
  const staleAfterMs = Math.max(
    options.staleAfterMs ?? DEFAULT_TASK_CLAIM_LEASE_MS,
    1
  );
  const retryMs = Math.max(options.retryMs ?? DEFAULT_LOCK_RETRY_MS, 1);
  const deadline = Date.now() + timeoutMs;
  let recoveredFrom: AgmoTeamStateLockRecoveredFrom | undefined;
  let lastExisting: ExistingLockReadResult = { kind: "missing" };

  await mkdir(resolveTeamStateLocksDir(teamName, cwd), { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath);
      const metadata = buildLockMetadata(
        normalizedLockName,
        ownerId,
        operation,
        staleAfterMs,
        recoveredFrom
      );
      try {
        await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return {
        lockName: normalizedLockName,
        lockPath,
        metadataPath,
        ownerId,
        metadata,
        release: async () => {
          await releaseTeamStateLock({
            lockName: normalizedLockName,
            lockPath,
            metadataPath,
            ownerId
          });
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
    }

    lastExisting = await readExistingLock(lockPath);
    if (lastExisting.kind === "valid" && lastExisting.stale) {
      recoveredFrom = {
        reason: "stale",
        metadata: lastExisting.metadata
      };
      await rm(lockPath, { recursive: true, force: true });
      continue;
    }
    if (lastExisting.kind === "malformed") {
      recoveredFrom = {
        reason: "malformed",
        ...(lastExisting.rawMetadata ? { raw_metadata: lastExisting.rawMetadata } : {}),
        error: lastExisting.error
      };
      await rm(lockPath, { recursive: true, force: true });
      continue;
    }

    if (Date.now() >= deadline) {
      throw buildLockTimeoutError(teamName, normalizedLockName, operation, lastExisting);
    }

    await sleepMs(Math.min(retryMs, Math.max(1, deadline - Date.now())));
  }
}

export async function releaseTeamStateLock(
  lock: Pick<
    AgmoTeamStateLockHandle,
    "lockName" | "lockPath" | "metadataPath" | "ownerId"
  >
): Promise<void> {
  const existing = await readExistingLock(lock.lockPath);
  if (existing.kind === "missing") {
    return;
  }
  if (existing.kind !== "valid") {
    throw new Error(
      `refusing to release team state lock "${lock.lockName}" because metadata is malformed`
    );
  }
  if (existing.metadata.owner_id !== lock.ownerId) {
    throw new Error(
      `refusing to release team state lock "${lock.lockName}" owned by ${existing.metadata.owner_id}; current owner is ${lock.ownerId}`
    );
  }

  await rm(lock.lockPath, { recursive: true, force: true });
}

export async function withTeamStateLock<T>(
  teamName: string,
  lockName: string,
  operation: string,
  callback: (lock: AgmoTeamStateLockHandle) => Promise<T>,
  cwd = process.cwd(),
  options: AgmoTeamStateLockOptions = {}
): Promise<T> {
  const lock = await acquireTeamStateLock(teamName, lockName, operation, cwd, options);
  try {
    return await callback(lock);
  } finally {
    await lock.release();
  }
}
