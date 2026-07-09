import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
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

test("runCleanupCommand rejects mutating subcommands in slice 1", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-cleanup-cli-reject-"));

  await assert.rejects(
    () => captureCleanupCommand(["run", "--confirm"], tempRoot),
    /usage: agmo cleanup inspect/
  );
});
