import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runConfigCommand } from "./config.js";

async function captureConfigCommand(args: string[], cwd: string, home: string): Promise<Record<string, unknown>> {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const stdoutChunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);

  process.env.HOME = home;
  process.chdir(cwd);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;

  try {
    await runConfigCommand(args);
  } finally {
    process.stdout.write = originalWrite;
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  return JSON.parse(stdoutChunks.join("")) as Record<string, unknown>;
}

test("runConfigCommand cleanup show reports effective defaults", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-config-cleanup-"));
  const tempHome = await mkdtemp(join(os.tmpdir(), "agmo-config-cleanup-home-"));

  const output = await captureConfigCommand(["cleanup", "show"], tempRoot, tempHome);
  const policy = output.policy as { enabled?: boolean; safe_auto_cleanup_on_launch?: boolean };
  const sources = output.sources as { effective?: { enabled?: string; safe_auto_cleanup_on_launch?: string } };

  assert.equal(output.command, "config cleanup show");
  assert.equal(output.mode, "effective");
  assert.equal(policy.enabled, true);
  assert.equal(policy.safe_auto_cleanup_on_launch, false);
  assert.equal(sources.effective?.enabled, "default");
  assert.equal(sources.effective?.safe_auto_cleanup_on_launch, "default");
});

test("runConfigCommand cleanup set writes scoped project config", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-config-cleanup-set-"));
  const tempHome = await mkdtemp(join(os.tmpdir(), "agmo-config-cleanup-set-home-"));
  await mkdir(join(tempRoot, ".agmo"), { recursive: true });

  const setOutput = await captureConfigCommand(
    ["cleanup", "set", "max_project_agmo_bytes", "123", "--scope", "project"],
    tempRoot,
    tempHome
  );
  const showOutput = await captureConfigCommand(["cleanup", "show"], tempRoot, tempHome);
  const policy = showOutput.policy as { max_project_agmo_bytes?: number };
  const sources = showOutput.sources as { effective?: { max_project_agmo_bytes?: string } };

  assert.equal(setOutput.command, "config cleanup set");
  assert.equal(setOutput.key, "max_project_agmo_bytes");
  assert.equal(setOutput.value, 123);
  assert.equal(policy.max_project_agmo_bytes, 123);
  assert.equal(sources.effective?.max_project_agmo_bytes, "project");
});
