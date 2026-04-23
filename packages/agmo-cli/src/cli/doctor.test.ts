import assert from "node:assert/strict";
import os from "node:os";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runDoctorCommand } from "./doctor.js";

test("runDoctorCommand reports launch workspace cleanup guidance without legacy runtime recommendations", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-doctor-cmd-project-"));
  const tempHome = await mkdtemp(join(os.tmpdir(), "agmo-doctor-cmd-home-"));

  await mkdir(join(tempProject, ".codex", "agents"), { recursive: true });
  await mkdir(join(tempProject, ".agmo", "state"), { recursive: true });
  await mkdir(join(tempProject, ".agmo", "cache", "launch-workspaces"), { recursive: true });

  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const stdoutChunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);

  process.env.HOME = tempHome;
  process.chdir(tempProject);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as typeof process.stdout.write;

  try {
    await runDoctorCommand(["--scope", "project"]);
  } finally {
    process.stdout.write = originalWrite;
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  const output = JSON.parse(stdoutChunks.join(""));
  assert.equal("legacy_runtime" in output, false);
  assert.equal("legacy_runtime" in output.recommendations, false);
  assert.ok(Array.isArray(output.recommendations.setup));
});
