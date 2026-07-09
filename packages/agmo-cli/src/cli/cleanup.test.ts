import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCleanupPlan } from "../cleanup/plan.js";
import { runCleanupPlan } from "../cleanup/run.js";
import { runCleanupCommand } from "./cleanup.js";

async function captureCleanupCommand(args: string[], cwd: string): Promise<Record<string, unknown>> {
  const originalCwd = process.cwd();
  const stdoutChunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);

  process.chdir(cwd);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;

  try {
    await runCleanupCommand(args);
  } finally {
    process.stdout.write = originalWrite;
    process.chdir(originalCwd);
  }

  return JSON.parse(stdoutChunks.join("")) as Record<string, unknown>;
}

test("runCleanupCommand inspect prints read-only machine JSON", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-cli-"));
  const sessionPath = join(tempRoot, ".agmo", "state", "sessions", "session-1.json");
  await mkdir(join(tempRoot, ".agmo", "state", "sessions"), { recursive: true });
  await writeFile(sessionPath, "{\"active\":false}\n", "utf8");

  const output = await captureCleanupCommand(["inspect", "--json"], tempRoot);
  const realTempRoot = await realpath(tempRoot);
  const totals = output.totals as { entries?: number; bytes?: number; cleanup_candidate_entries?: number };
  const categories = output.categories as Array<{ category?: string; entries?: number }>;

  assert.equal(output.schema_version, "1.0");
  assert.equal(output.operation, "cleanup.inspect");
  assert.equal(output.ok, true);
  assert.equal(output.command, "cleanup inspect");
  assert.equal(output.project_root, realTempRoot);
  assert.equal(typeof totals.bytes, "number");
  assert.equal(totals.cleanup_candidate_entries, 0);
  assert.ok(categories.some((entry) => entry.category === "state/sessions" && entry.entries === 1));
  assert.equal(existsSync(sessionPath), true);
});

test("runCleanupCommand rejects cleanup run without confirm and does not delete", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-cli-reject-"));
  const logPath = join(tempRoot, ".agmo", "logs", "old.log");
  await mkdir(join(tempRoot, ".agmo", "logs"), { recursive: true });
  await writeFile(logPath, "old log\n", "utf8");

  await assert.rejects(
    () => captureCleanupCommand(["run", "--older-than-days", "1"], tempRoot),
    /cleanup run requires --confirm/
  );
  assert.equal(existsSync(logPath), true);
});

test("runCleanupCommand plan prints non-mutating machine JSON", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-cli-plan-"));
  const logPath = join(tempRoot, ".agmo", "logs", "old.log");
  await mkdir(join(tempRoot, ".agmo", "logs"), { recursive: true });
  await writeFile(logPath, "old log\n", "utf8");
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await utimes(logPath, oldDate, oldDate);

  const output = await captureCleanupCommand(["plan", "--json", "--older-than-days", "1"], tempRoot);
  const totals = output.totals as { would_delete_entries?: number; would_delete_bytes?: number };
  const wouldDelete = output.would_delete as Array<{ relative_path?: string; reason?: string }>;

  assert.equal(output.schema_version, "1.0");
  assert.equal(output.operation, "cleanup.plan");
  assert.equal(output.ok, true);
  assert.equal(output.command, "cleanup plan");
  assert.equal(totals.would_delete_entries, 1);
  assert.ok((totals.would_delete_bytes ?? 0) > 0);
  assert.deepEqual(wouldDelete.map((entry) => entry.relative_path), [".agmo/logs/old.log"]);
  assert.equal(wouldDelete[0]?.reason, "Agmo log older than retention threshold");
  assert.equal(existsSync(logPath), true);
});

test("runCleanupCommand run deletes a planned old log and reports ledger", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-cli-run-log-"));
  const logPath = join(tempRoot, ".agmo", "logs", "old.log");
  await mkdir(join(tempRoot, ".agmo", "logs"), { recursive: true });
  await writeFile(logPath, "old log\n", "utf8");
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await utimes(logPath, oldDate, oldDate);

  const output = await captureCleanupCommand(["run", "--confirm", "--json", "--older-than-days", "1"], tempRoot);
  const removed = output.removed as Array<{
    relative_path?: string;
    category?: string;
    bytes?: number;
    reason?: string;
  }>;
  const runTotals = output.run_totals as {
    planned_entries?: number;
    removed_entries?: number;
    removed_bytes?: number;
    skipped_entries?: number;
    failure_entries?: number;
  };

  assert.equal(output.schema_version, "1.0");
  assert.equal(output.operation, "cleanup.run");
  assert.equal(output.ok, true);
  assert.equal(output.command, "cleanup run");
  assert.deepEqual(
    removed.map((entry) => ({
      relative_path: entry.relative_path,
      category: entry.category,
      reason: entry.reason
    })),
    [
      {
        relative_path: ".agmo/logs/old.log",
        category: "logs",
        reason: "Agmo log older than retention threshold"
      }
    ]
  );
  assert.equal(runTotals.planned_entries, 1);
  assert.equal(runTotals.removed_entries, 1);
  assert.ok((runTotals.removed_bytes ?? 0) > 0);
  assert.equal(runTotals.skipped_entries, 0);
  assert.equal(runTotals.failure_entries, 0);
  assert.equal(existsSync(logPath), false);
});

test("runCleanupCommand run deletes a planned clean inactive launch workspace", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-cli-run-launch-"));
  const workspaceDir = join(tempRoot, ".agmo", "cache", "launch-workspaces", "session-1");
  const workspaceRoot = join(workspaceDir, "workspace");
  const metadataPath = join(workspaceDir, "metadata.json");
  await mkdir(workspaceRoot, { recursive: true });
  execFileSync("git", ["init"], { cwd: workspaceRoot, stdio: "ignore" });
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        session_id: "session-1",
        project_root: tempRoot,
        workspace_root: workspaceRoot,
        composed_agents_path: join(tempRoot, ".agmo", "cache", "session-instructions", "session-1", "AGENTS.md"),
        created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        active: false
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const output = await captureCleanupCommand(["run", "--confirm", "--json", "--older-than-days", "0"], tempRoot);
  const removed = output.removed as Array<{ relative_path?: string; category?: string; reason?: string }>;

  assert.ok(
    removed.some(
      (entry) =>
        entry.relative_path === ".agmo/cache/launch-workspaces/session-1" &&
        entry.category === "cache/launch-workspaces" &&
        entry.reason === "inactive clean launch workspace older than retention threshold"
    )
  );
  assert.equal(existsSync(workspaceDir), false);
});

test("runCleanupCommand run deletes a planned old inactive Agmo state file", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-cli-run-state-"));
  const statePath = join(tempRoot, ".agmo", "state", "sessions", "session-1.json");
  await mkdir(join(tempRoot, ".agmo", "state", "sessions"), { recursive: true });
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        version: 1,
        session_id: "session-1",
        active: false,
        last_event: "Stop",
        updated_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await utimes(statePath, oldDate, oldDate);

  const output = await captureCleanupCommand(["run", "--confirm", "--json", "--older-than-days", "1"], tempRoot);
  const removed = output.removed as Array<{ relative_path?: string; category?: string; reason?: string }>;

  assert.deepEqual(
    removed.map((entry) => ({
      relative_path: entry.relative_path,
      category: entry.category,
      reason: entry.reason
    })),
    [
      {
        relative_path: ".agmo/state/sessions/session-1.json",
        category: "state/sessions",
        reason: "inactive state file older than retention threshold"
      }
    ]
  );
  assert.equal(existsSync(statePath), false);
});

test("runCleanupCommand run only removes planned entries and keeps protected local artifacts", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-cli-run-protected-"));
  const logPath = join(tempRoot, ".agmo", "logs", "old.log");
  const memoryPath = join(tempRoot, ".agmo", "memory", "wisdom.json");
  const workspaceRoot = join(tempRoot, ".agmo", "cache", "launch-workspaces", "session-1", "workspace");
  const metadataPath = join(tempRoot, ".agmo", "cache", "launch-workspaces", "session-1", "metadata.json");
  const sessionInstructionsDir = join(tempRoot, ".agmo", "cache", "session-instructions", "session-1");
  const sessionInstructionsPath = join(sessionInstructionsDir, "AGENTS.md");
  await mkdir(join(tempRoot, ".agmo", "logs"), { recursive: true });
  await mkdir(join(tempRoot, ".agmo", "memory"), { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(sessionInstructionsDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: workspaceRoot, stdio: "ignore" });
  await writeFile(logPath, "old log\n", "utf8");
  await writeFile(memoryPath, "memory\n", "utf8");
  await writeFile(join(workspaceRoot, "draft.txt"), "dirty\n", "utf8");
  await writeFile(sessionInstructionsPath, "instructions\n", "utf8");
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        session_id: "session-1",
        project_root: tempRoot,
        workspace_root: workspaceRoot,
        composed_agents_path: sessionInstructionsPath,
        created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        active: false
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  for (const path of [
    logPath,
    memoryPath,
    join(tempRoot, ".agmo", "cache", "launch-workspaces", "session-1"),
    sessionInstructionsDir,
    sessionInstructionsPath
  ]) {
    await utimes(path, oldDate, oldDate);
  }

  const output = await captureCleanupCommand(["run", "--confirm", "--json", "--older-than-days", "1"], tempRoot);
  const removed = output.removed as Array<{ relative_path?: string }>;
  const kept = output.kept as Array<{ relative_path?: string; reason?: string }>;

  assert.deepEqual(removed.map((entry) => entry.relative_path), [".agmo/logs/old.log"]);
  assert.ok(kept.some((entry) => entry.relative_path === ".agmo/memory/wisdom.json"));
  assert.ok(
    kept.some(
      (entry) =>
        entry.relative_path === ".agmo/cache/launch-workspaces/session-1" &&
        entry.reason === "dirty launch workspace"
    )
  );
  assert.ok(
    kept.some(
      (entry) =>
        entry.relative_path === ".agmo/cache/session-instructions/session-1" &&
        entry.reason === "session instructions referenced by protected launch workspace"
    )
  );
  assert.equal(existsSync(logPath), false);
  assert.equal(existsSync(memoryPath), true);
  assert.equal(existsSync(join(workspaceRoot, "draft.txt")), true);
  assert.equal(existsSync(sessionInstructionsPath), true);
});

test("runCleanupCommand run is idempotent", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-cli-run-idempotent-"));
  const logPath = join(tempRoot, ".agmo", "logs", "old.log");
  await mkdir(join(tempRoot, ".agmo", "logs"), { recursive: true });
  await writeFile(logPath, "old log\n", "utf8");
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await utimes(logPath, oldDate, oldDate);

  const first = await captureCleanupCommand(["run", "--confirm", "--json", "--older-than-days", "1"], tempRoot);
  const second = await captureCleanupCommand(["run", "--confirm", "--json", "--older-than-days", "1"], tempRoot);
  const firstTotals = first.run_totals as { removed_entries?: number };
  const secondTotals = second.run_totals as { planned_entries?: number; removed_entries?: number };

  assert.equal(firstTotals.removed_entries, 1);
  assert.equal(secondTotals.planned_entries, 0);
  assert.equal(secondTotals.removed_entries, 0);
  assert.equal(existsSync(logPath), false);
});

test("runCleanupCommand run does not delete or follow symlinks", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-cli-run-symlink-"));
  const outsidePath = join(tempRoot, "outside.log");
  const linkPath = join(tempRoot, ".agmo", "logs", "link.log");
  await mkdir(join(tempRoot, ".agmo", "logs"), { recursive: true });
  await writeFile(outsidePath, "outside\n", "utf8");
  await symlink(outsidePath, linkPath);

  const output = await captureCleanupCommand(["run", "--confirm", "--json", "--older-than-days", "0"], tempRoot);
  const removed = output.removed as Array<{ relative_path?: string }>;
  const kept = output.kept as Array<{ relative_path?: string; reason?: string }>;

  assert.deepEqual(removed, []);
  assert.ok(
    kept.some(
      (entry) => entry.relative_path === ".agmo/logs/link.log" && entry.reason === "symlink kept for manual review"
    )
  );
  assert.equal(existsSync(linkPath), true);
  assert.equal(existsSync(outsidePath), true);
});

test("runCleanupPlan skips a planned path that changes to a symlink before deletion", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-cli-run-revalidate-"));
  const logPath = join(tempRoot, ".agmo", "logs", "old.log");
  const outsidePath = join(tempRoot, "outside.log");
  await mkdir(join(tempRoot, ".agmo", "logs"), { recursive: true });
  await writeFile(logPath, "old log\n", "utf8");
  await writeFile(outsidePath, "outside\n", "utf8");
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await utimes(logPath, oldDate, oldDate);
  const plan = await createCleanupPlan(tempRoot, { olderThanDays: 1 });

  await unlink(logPath);
  await symlink(outsidePath, logPath);

  const result = await runCleanupPlan(plan);

  assert.deepEqual(result.run.removed, []);
  assert.deepEqual(
    result.run.skipped.map((entry) => ({
      relative_path: entry.relative_path,
      skipped_reason: entry.skipped_reason
    })),
    [{ relative_path: ".agmo/logs/old.log", skipped_reason: "planned path is now a symlink" }]
  );
  assert.equal(existsSync(logPath), true);
  assert.equal(existsSync(outsidePath), true);
});

test("runCleanupCommand plan keeps dirty launch workspaces", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-cli-plan-dirty-"));
  const workspaceRoot = join(tempRoot, ".agmo", "cache", "launch-workspaces", "session-1", "workspace");
  const metadataPath = join(tempRoot, ".agmo", "cache", "launch-workspaces", "session-1", "metadata.json");
  const sessionInstructionsPath = join(tempRoot, ".agmo", "cache", "session-instructions", "session-1", "AGENTS.md");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(join(tempRoot, ".agmo", "cache", "session-instructions", "session-1"), { recursive: true });
  execFileSync("git", ["init"], { cwd: workspaceRoot, stdio: "ignore" });
  await writeFile(join(workspaceRoot, "draft.txt"), "dirty\n", "utf8");
  await writeFile(sessionInstructionsPath, "instructions\n", "utf8");
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        session_id: "session-1",
        project_root: tempRoot,
        workspace_root: workspaceRoot,
        composed_agents_path: join(tempRoot, ".agmo", "cache", "session-instructions", "session-1", "AGENTS.md"),
        created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        active: false
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await utimes(join(tempRoot, ".agmo", "cache", "launch-workspaces", "session-1"), oldDate, oldDate);
  await utimes(sessionInstructionsPath, oldDate, oldDate);
  await utimes(join(tempRoot, ".agmo", "cache", "session-instructions", "session-1"), oldDate, oldDate);

  const output = await captureCleanupCommand(["plan", "--json", "--older-than-days", "1"], tempRoot);
  const wouldDelete = output.would_delete as Array<{ relative_path?: string }>;
  const kept = output.kept as Array<{ relative_path?: string; reason?: string }>;

  assert.equal(
    wouldDelete.some((entry) => entry.relative_path === ".agmo/cache/launch-workspaces/session-1"),
    false
  );
  assert.ok(
    kept.some(
      (entry) =>
        entry.relative_path === ".agmo/cache/launch-workspaces/session-1" &&
        entry.reason === "dirty launch workspace"
    )
  );
  assert.ok(
    kept.some(
      (entry) =>
        entry.relative_path === ".agmo/cache/session-instructions/session-1" &&
        entry.reason === "session instructions referenced by protected launch workspace"
    )
  );
  assert.equal(existsSync(join(workspaceRoot, "draft.txt")), true);
  assert.equal(existsSync(sessionInstructionsPath), true);
});

test("runCleanupCommand plan protects session instructions by composed agents path", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-cli-plan-composed-path-"));
  const workspaceRoot = join(tempRoot, ".agmo", "cache", "launch-workspaces", "session-1", "workspace");
  const metadataPath = join(tempRoot, ".agmo", "cache", "launch-workspaces", "session-1", "metadata.json");
  const sessionInstructionsPath = join(tempRoot, ".agmo", "cache", "session-instructions", "other", "AGENTS.md");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(join(tempRoot, ".agmo", "cache", "session-instructions", "other"), { recursive: true });
  execFileSync("git", ["init"], { cwd: workspaceRoot, stdio: "ignore" });
  await writeFile(join(workspaceRoot, "draft.txt"), "dirty\n", "utf8");
  await writeFile(sessionInstructionsPath, "instructions\n", "utf8");
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        session_id: "session-1",
        project_root: tempRoot,
        workspace_root: workspaceRoot,
        composed_agents_path: sessionInstructionsPath,
        created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        active: false
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await utimes(join(tempRoot, ".agmo", "cache", "launch-workspaces", "session-1"), oldDate, oldDate);
  await utimes(join(tempRoot, ".agmo", "cache", "session-instructions", "other"), oldDate, oldDate);
  await utimes(sessionInstructionsPath, oldDate, oldDate);

  const output = await captureCleanupCommand(["plan", "--json", "--older-than-days", "1"], tempRoot);
  const wouldDelete = output.would_delete as Array<{ relative_path?: string }>;
  const kept = output.kept as Array<{ relative_path?: string; reason?: string }>;

  assert.equal(
    wouldDelete.some((entry) => entry.relative_path === ".agmo/cache/session-instructions/other"),
    false
  );
  assert.ok(
    kept.some(
      (entry) =>
        entry.relative_path === ".agmo/cache/session-instructions/other" &&
        entry.reason === "session instructions referenced by protected launch workspace"
    )
  );
  assert.equal(existsSync(sessionInstructionsPath), true);
});

test("runCleanupCommand plan output ordering is deterministic", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-cli-plan-order-"));
  const logB = join(tempRoot, ".agmo", "logs", "b.log");
  const logA = join(tempRoot, ".agmo", "logs", "a.log");
  const sessionB = join(tempRoot, ".agmo", "cache", "session-instructions", "b", "AGENTS.md");
  const sessionA = join(tempRoot, ".agmo", "cache", "session-instructions", "a", "AGENTS.md");
  await mkdir(join(tempRoot, ".agmo", "logs"), { recursive: true });
  await mkdir(join(tempRoot, ".agmo", "cache", "session-instructions", "a"), { recursive: true });
  await mkdir(join(tempRoot, ".agmo", "cache", "session-instructions", "b"), { recursive: true });
  await writeFile(logB, "b\n", "utf8");
  await writeFile(logA, "a\n", "utf8");
  await writeFile(sessionB, "b\n", "utf8");
  await writeFile(sessionA, "a\n", "utf8");
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  for (const path of [
    logB,
    logA,
    sessionB,
    sessionA,
    join(tempRoot, ".agmo", "cache", "session-instructions", "a"),
    join(tempRoot, ".agmo", "cache", "session-instructions", "b")
  ]) {
    await utimes(path, oldDate, oldDate);
  }

  const output = await captureCleanupCommand(["plan", "--json", "--older-than-days", "1"], tempRoot);
  const wouldDelete = output.would_delete as Array<{ relative_path?: string }>;

  assert.deepEqual(
    wouldDelete.map((entry) => entry.relative_path),
    [
      ".agmo/cache/session-instructions/a",
      ".agmo/cache/session-instructions/b",
      ".agmo/logs/a.log",
      ".agmo/logs/b.log"
    ]
  );
});

test("runCleanupCommand plan older-than override changes safe eligibility", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-cli-plan-ttl-"));
  const logPath = join(tempRoot, ".agmo", "logs", "two-days.log");
  await mkdir(join(tempRoot, ".agmo", "logs"), { recursive: true });
  await writeFile(logPath, "ttl\n", "utf8");
  const oldDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await utimes(logPath, oldDate, oldDate);

  const keptOutput = await captureCleanupCommand(["plan", "--json", "--older-than-days", "3"], tempRoot);
  const deleteOutput = await captureCleanupCommand(["plan", "--json", "--older-than-days", "1"], tempRoot);

  assert.deepEqual(keptOutput.would_delete, []);
  assert.deepEqual(
    (deleteOutput.would_delete as Array<{ relative_path?: string }>).map((entry) => entry.relative_path),
    [".agmo/logs/two-days.log"]
  );
  assert.equal(existsSync(logPath), true);
});

test("runCleanupCommand plan max-bytes selects safe kept entries without deleting", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-cli-plan-size-"));
  const logPath = join(tempRoot, ".agmo", "logs", "new.log");
  const memoryPath = join(tempRoot, ".agmo", "memory", "wisdom.json");
  await mkdir(join(tempRoot, ".agmo", "logs"), { recursive: true });
  await mkdir(join(tempRoot, ".agmo", "memory"), { recursive: true });
  await writeFile(logPath, "1234567890\n", "utf8");
  await writeFile(memoryPath, "memory\n", "utf8");

  const output = await captureCleanupCommand(["plan", "--json", "--older-than-days", "30", "--max-bytes", "1"], tempRoot);
  const wouldDelete = output.would_delete as Array<{ relative_path?: string; reason?: string }>;
  const kept = output.kept as Array<{ relative_path?: string; reason?: string }>;

  assert.ok(
    wouldDelete.some(
      (entry) => entry.relative_path === ".agmo/logs/new.log" && entry.reason === "selected by project size cap"
    )
  );
  assert.ok(
    kept.some(
      (entry) => entry.relative_path === ".agmo/memory/wisdom.json" && entry.reason === "memory is inspect-only"
    )
  );
  assert.equal(existsSync(logPath), true);
  assert.equal(existsSync(memoryPath), true);
});

test("runCleanupCommand plan max-bytes preserves protected entries", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-cli-plan-size-keep-"));
  const workspaceRoot = join(tempRoot, ".agmo", "cache", "launch-workspaces", "session-1", "workspace");
  const metadataPath = join(tempRoot, ".agmo", "cache", "launch-workspaces", "session-1", "metadata.json");
  const sessionInstructionsDir = join(tempRoot, ".agmo", "cache", "session-instructions", "session-1");
  const sessionInstructionsPath = join(sessionInstructionsDir, "AGENTS.md");
  const latestBackup = join(tempRoot, ".agmo", "backups", "setup", "2026-01-02T00-00-00.000Z");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(sessionInstructionsDir, { recursive: true });
  await mkdir(latestBackup, { recursive: true });
  execFileSync("git", ["init"], { cwd: workspaceRoot, stdio: "ignore" });
  await writeFile(join(workspaceRoot, "draft.txt"), "dirty\n", "utf8");
  await writeFile(sessionInstructionsPath, "protected instructions\n", "utf8");
  await writeFile(join(latestBackup, "AGENTS.md.bak"), "latest backup\n", "utf8");
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        session_id: "session-1",
        project_root: tempRoot,
        workspace_root: workspaceRoot,
        composed_agents_path: sessionInstructionsPath,
        created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        active: false
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const output = await captureCleanupCommand(["plan", "--json", "--max-bytes", "1"], tempRoot);
  const wouldDelete = output.would_delete as Array<{ relative_path?: string }>;
  const kept = output.kept as Array<{ relative_path?: string; reason?: string }>;

  assert.equal(
    wouldDelete.some(
      (entry) =>
        entry.relative_path === ".agmo/cache/session-instructions/session-1" ||
        entry.relative_path === ".agmo/backups/setup/2026-01-02T00-00-00.000Z"
    ),
    false
  );
  assert.ok(
    kept.some(
      (entry) =>
        entry.relative_path === ".agmo/cache/session-instructions/session-1" &&
        entry.reason === "session instructions referenced by protected launch workspace"
    )
  );
  assert.ok(
    kept.some(
      (entry) =>
        entry.relative_path === ".agmo/backups/setup/2026-01-02T00-00-00.000Z" &&
        entry.reason === "latest setup backup kept"
    )
  );
  assert.equal(existsSync(sessionInstructionsPath), true);
  assert.equal(existsSync(join(latestBackup, "AGENTS.md.bak")), true);
});

test("runCleanupCommand plan keeps latest setup backup", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-cli-plan-backup-"));
  const oldBackup = join(tempRoot, ".agmo", "backups", "setup", "2026-01-01T00-00-00.000Z");
  const newBackup = join(tempRoot, ".agmo", "backups", "setup", "2026-01-02T00-00-00.000Z");
  await mkdir(oldBackup, { recursive: true });
  await mkdir(newBackup, { recursive: true });
  await writeFile(join(oldBackup, "AGENTS.md.bak"), "old\n", "utf8");
  await writeFile(join(newBackup, "AGENTS.md.bak"), "new\n", "utf8");
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  const newerDate = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
  await utimes(join(oldBackup, "AGENTS.md.bak"), oldDate, oldDate);
  await utimes(oldBackup, oldDate, oldDate);
  await utimes(join(newBackup, "AGENTS.md.bak"), newerDate, newerDate);
  await utimes(newBackup, newerDate, newerDate);

  const output = await captureCleanupCommand(["plan", "--json", "--older-than-days", "1"], tempRoot);
  const wouldDelete = output.would_delete as Array<{ relative_path?: string }>;
  const kept = output.kept as Array<{ relative_path?: string; reason?: string }>;

  assert.deepEqual(
    wouldDelete.map((entry) => entry.relative_path),
    [".agmo/backups/setup/2026-01-01T00-00-00.000Z"]
  );
  assert.ok(
    kept.some(
      (entry) =>
        entry.relative_path === ".agmo/backups/setup/2026-01-02T00-00-00.000Z" &&
        entry.reason === "latest setup backup kept"
    )
  );
  assert.equal(existsSync(join(oldBackup, "AGENTS.md.bak")), true);
  assert.equal(existsSync(join(newBackup, "AGENTS.md.bak")), true);
});

test("runCleanupCommand plan keeps malformed state files", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-cli-plan-malformed-"));
  const statePath = join(tempRoot, ".agmo", "state", "sessions", "broken.json");
  await mkdir(join(tempRoot, ".agmo", "state", "sessions"), { recursive: true });
  await writeFile(statePath, "{not json\n", "utf8");
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await utimes(statePath, oldDate, oldDate);

  const output = await captureCleanupCommand(["plan", "--json", "--older-than-days", "1"], tempRoot);
  const wouldDelete = output.would_delete as Array<{ relative_path?: string }>;
  const kept = output.kept as Array<{ relative_path?: string; reason?: string }>;

  assert.equal(
    wouldDelete.some((entry) => entry.relative_path === ".agmo/state/sessions/broken.json"),
    false
  );
  assert.ok(
    kept.some(
      (entry) =>
        entry.relative_path === ".agmo/state/sessions/broken.json" &&
        entry.reason === "malformed state file kept for manual review"
    )
  );
  assert.equal(existsSync(statePath), true);
});

test("runCleanupCommand plan keeps state files without Agmo runtime shape evidence", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-cli-plan-state-unknown-"));
  const statePath = join(tempRoot, ".agmo", "state", "sessions", "unknown.json");
  await mkdir(join(tempRoot, ".agmo", "state", "sessions"), { recursive: true });
  await writeFile(statePath, "{\"active\":false}\n", "utf8");
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await utimes(statePath, oldDate, oldDate);

  const output = await captureCleanupCommand(["plan", "--json", "--older-than-days", "1"], tempRoot);
  const wouldDelete = output.would_delete as Array<{ relative_path?: string }>;
  const kept = output.kept as Array<{ relative_path?: string; reason?: string }>;

  assert.equal(
    wouldDelete.some((entry) => entry.relative_path === ".agmo/state/sessions/unknown.json"),
    false
  );
  assert.ok(
    kept.some(
      (entry) =>
        entry.relative_path === ".agmo/state/sessions/unknown.json" &&
        entry.reason === "state file lacks Agmo runtime shape evidence"
    )
  );
  assert.equal(existsSync(statePath), true);
});

test("runCleanupCommand plan can select old inactive Agmo state files", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-cli-plan-state-inactive-"));
  const statePath = join(tempRoot, ".agmo", "state", "sessions", "session-1.json");
  await mkdir(join(tempRoot, ".agmo", "state", "sessions"), { recursive: true });
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        version: 1,
        session_id: "session-1",
        active: false,
        last_event: "Stop",
        updated_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await utimes(statePath, oldDate, oldDate);

  const output = await captureCleanupCommand(["plan", "--json", "--older-than-days", "1"], tempRoot);
  const wouldDelete = output.would_delete as Array<{ relative_path?: string; reason?: string }>;

  assert.ok(
    wouldDelete.some(
      (entry) =>
        entry.relative_path === ".agmo/state/sessions/session-1.json" &&
        entry.reason === "inactive state file older than retention threshold"
    )
  );
  assert.equal(existsSync(statePath), true);
});
