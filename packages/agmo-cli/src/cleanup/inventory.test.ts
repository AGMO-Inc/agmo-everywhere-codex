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
