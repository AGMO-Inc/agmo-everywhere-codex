import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectCleanupInventory } from "./inventory.js";

test("collectCleanupInventory reports known categories and never deletes files", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-inventory-"));
  const sessionPath = join(tempRoot, ".agmo", "state", "sessions", "session-1.json");
  const workflowPath = join(tempRoot, ".agmo", "state", "workflows", "session-1.json");
  const memoryPath = join(tempRoot, ".agmo", "memory", "wisdom.json");
  await mkdir(join(tempRoot, ".agmo", "state", "sessions"), { recursive: true });
  await mkdir(join(tempRoot, ".agmo", "state", "workflows"), { recursive: true });
  await mkdir(join(tempRoot, ".agmo", "memory"), { recursive: true });
  await writeFile(sessionPath, "{\"active\":false}\n", "utf8");
  await writeFile(workflowPath, "{\"active\":false}\n", "utf8");
  await writeFile(memoryPath, "{\"items\":[]}\n", "utf8");

  const inventory = await collectCleanupInventory(tempRoot);
  const sessions = inventory.categories.find((entry) => entry.category === "state/sessions");
  const workflows = inventory.categories.find((entry) => entry.category === "state/workflows");
  const memory = inventory.entries.find((entry) => entry.relative_path.endsWith("wisdom.json"));

  assert.ok(sessions);
  assert.ok(workflows);
  assert.equal(sessions.entries, 1);
  assert.equal(workflows.entries, 1);
  assert.ok((sessions.bytes ?? 0) > 0);
  assert.equal(memory?.keep_reason, "memory is inspect-only");
  assert.equal(inventory.totals.cleanup_candidate_entries, 0);
  assert.equal(existsSync(sessionPath), true);
  assert.equal(existsSync(workflowPath), true);
  assert.equal(existsSync(memoryPath), true);
});

test("collectCleanupInventory keeps dirty launch workspaces with an explicit reason", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-launch-dirty-"));
  const workspaceRoot = join(tempRoot, ".agmo", "cache", "launch-workspaces", "session-1", "workspace");
  const metadataPath = join(tempRoot, ".agmo", "cache", "launch-workspaces", "session-1", "metadata.json");
  await mkdir(workspaceRoot, { recursive: true });
  execFileSync("git", ["init"], { cwd: workspaceRoot, stdio: "ignore" });
  await writeFile(join(workspaceRoot, "draft.txt"), "dirty\n", "utf8");
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        session_id: "session-1",
        project_root: tempRoot,
        workspace_root: workspaceRoot,
        composed_agents_path: join(tempRoot, ".agmo", "cache", "session-instructions", "session-1", "AGENTS.md"),
        created_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        active: false
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const inventory = await collectCleanupInventory(tempRoot);
  const launchEntry = inventory.entries.find(
    (entry) => entry.category === "cache/launch-workspaces"
  );

  assert.equal(launchEntry?.keep_reason, "dirty launch workspace");
  assert.equal(launchEntry?.cleanup_eligible, false);
  assert.deepEqual((launchEntry?.details as { dirty_state?: string } | undefined)?.dirty_state, "dirty");
  assert.equal(existsSync(join(workspaceRoot, "draft.txt")), true);
});

test("collectCleanupInventory records stable launch retention timestamp separately from physical mtime", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-launch-retention-"));
  const workspaceRoot = join(tempRoot, ".agmo", "cache", "launch-workspaces", "session-1", "workspace");
  const metadataPath = join(tempRoot, ".agmo", "cache", "launch-workspaces", "session-1", "metadata.json");
  const lastExitAt = "2026-01-02T03:04:05.000Z";
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        session_id: "session-1",
        project_root: tempRoot,
        workspace_root: workspaceRoot,
        created_at: "2026-01-01T00:00:00.000Z",
        last_exit_at: lastExitAt,
        active: false
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const inventory = await collectCleanupInventory(tempRoot);
  const launchEntry = inventory.entries.find(
    (entry) => entry.category === "cache/launch-workspaces"
  );

  assert.equal(launchEntry?.details?.retention_mtime_ms, Date.parse(lastExitAt));
  assert.equal(typeof launchEntry?.mtime_ms, "number");
  assert.notEqual(launchEntry?.mtime_ms, launchEntry?.details?.retention_mtime_ms);
});

test("collectCleanupInventory reports null launch retention timestamp for invalid metadata dates", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-launch-invalid-retention-"));
  const workspaceRoot = join(tempRoot, ".agmo", "cache", "launch-workspaces", "session-1", "workspace");
  const metadataPath = join(tempRoot, ".agmo", "cache", "launch-workspaces", "session-1", "metadata.json");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        session_id: "session-1",
        project_root: tempRoot,
        workspace_root: workspaceRoot,
        created_at: "not-a-date",
        last_exit_at: "also-not-a-date",
        active: false
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const inventory = await collectCleanupInventory(tempRoot);
  const launchEntry = inventory.entries.find(
    (entry) => entry.category === "cache/launch-workspaces"
  );

  assert.equal(launchEntry?.details?.retention_mtime_ms, null);
  assert.equal(typeof launchEntry?.mtime_ms, "number");
});

test("collectCleanupInventory reports symlinks without following them", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-symlink-"));
  const outside = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-outside-"));
  const linkPath = join(tempRoot, ".agmo", "logs", "outside-link");
  await mkdir(join(tempRoot, ".agmo", "logs"), { recursive: true });
  await writeFile(join(outside, "large.txt"), "outside\n", "utf8");
  await symlink(outside, linkPath);

  const inventory = await collectCleanupInventory(tempRoot);
  const linkEntry = inventory.entries.find((entry) => entry.relative_path.endsWith("outside-link"));

  assert.equal(linkEntry?.kind, "symlink");
  assert.equal(linkEntry?.cleanup_eligible, false);
  assert.equal(existsSync(join(outside, "large.txt")), true);
});
