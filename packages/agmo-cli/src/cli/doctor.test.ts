import assert from "node:assert/strict";
import os from "node:os";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { inspectLegacyRuntimeArtifacts } from "./doctor.js";
import { runDoctorCommand } from "./doctor.js";

test("inspectLegacyRuntimeArtifacts reports project and user .omx directories independently", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-doctor-project-"));
  const tempHome = await mkdtemp(join(os.tmpdir(), "agmo-doctor-home-"));

  await mkdir(join(tempProject, ".omx"), { recursive: true });

  const projectOnly = inspectLegacyRuntimeArtifacts(tempProject, tempHome);
  assert.equal(projectOnly.project_omx_exists, true);
  assert.equal(projectOnly.user_omx_exists, false);
  assert.match(projectOnly.project_omx_dir, /\.omx$/);
  assert.match(projectOnly.user_omx_dir, /\.omx$/);

  await mkdir(join(tempHome, ".omx"), { recursive: true });

  const projectAndUser = inspectLegacyRuntimeArtifacts(tempProject, tempHome);
  assert.equal(projectAndUser.project_omx_exists, true);
  assert.equal(projectAndUser.user_omx_exists, true);
});

test("runDoctorCommand recommends scope-specific legacy runtime migration commands", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-doctor-cmd-project-"));
  const tempHome = await mkdtemp(join(os.tmpdir(), "agmo-doctor-cmd-home-"));

  await mkdir(join(tempProject, ".codex"), { recursive: true });
  await mkdir(join(tempProject, ".agmo", "state"), { recursive: true });
  await mkdir(join(tempProject, ".agmo", "cache", "launch-workspaces"), { recursive: true });
  await mkdir(join(tempProject, ".omx"), { recursive: true });
  await mkdir(join(tempHome, ".omx"), { recursive: true });

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
  assert.deepEqual(output.recommendations.legacy_runtime.map((entry: { command: string }) => entry.command), [
    "agmo setup migrate-legacy --scope project",
    "agmo setup migrate-legacy --scope user"
  ]);
});
