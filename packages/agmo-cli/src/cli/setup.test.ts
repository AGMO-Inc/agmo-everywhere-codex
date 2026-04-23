import assert from "node:assert/strict";
import os from "node:os";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  migrateLegacyRuntimeArtifacts,
  resolveLegacyRuntimePaths
} from "./setup.js";

test("migrateLegacyRuntimeArtifacts archives legacy project .omx state into .agmo/legacy", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-setup-project-"));
  const sourcePath = join(tempProject, ".omx");
  await mkdir(join(sourcePath, "state"), { recursive: true });

  const result = await migrateLegacyRuntimeArtifacts({
    scope: "project",
    cwd: tempProject,
    now: new Date("2026-04-23T00:00:00.000Z")
  });

  assert.equal(result.status, "archived");
  assert.equal(result.archive_path, join(tempProject, ".agmo", "legacy", "omx", "project-2026-04-23T00-00-00-000Z"));
  assert.equal(existsSync(sourcePath), false);
  assert.equal(existsSync(result.archive_path!), true);
});

test("migrateLegacyRuntimeArtifacts deletes legacy user .omx state when requested", async () => {
  const tempHome = await mkdtemp(join(os.tmpdir(), "agmo-setup-home-"));
  const { sourcePath } = resolveLegacyRuntimePaths("user", process.cwd(), tempHome);
  await mkdir(join(sourcePath, "logs"), { recursive: true });

  const result = await migrateLegacyRuntimeArtifacts({
    scope: "user",
    userHome: tempHome,
    mode: "delete"
  });

  assert.equal(result.status, "deleted");
  assert.equal(result.archive_path, null);
  assert.equal(existsSync(sourcePath), false);
});
