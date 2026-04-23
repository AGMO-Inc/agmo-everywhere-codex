import assert from "node:assert/strict";
import os from "node:os";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  installScopedCodexPlugin,
  migrateLegacyRuntimeArtifacts,
  resolveLegacyRuntimePaths,
  resolveSetupScope
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

test("resolveSetupScope prompts when setup scope is omitted in an interactive terminal", async () => {
  let promptCalls = 0;
  const result = await resolveSetupScope([], {
    interactive: true,
    prompt: async () => {
      promptCalls += 1;
      return "user";
    }
  });

  assert.equal(promptCalls, 1);
  assert.deepEqual(result, {
    scope: "user",
    source: "prompt"
  });
});

test("resolveSetupScope requires --scope outside a tty when setup scope is omitted", async () => {
  await assert.rejects(
    () =>
      resolveSetupScope([], {
        interactive: false
      }),
    /Missing --scope user\|project\. Run interactively to choose a scope\./
  );
});

test("installScopedCodexPlugin writes project-scoped marketplace, cache, and activation config", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-setup-plugin-"));
  const result = await installScopedCodexPlugin("project", tempProject);

  assert.equal(result.scope, "project");
  assert.equal(existsSync(join(tempProject, ".codex", "plugins", "marketplaces", "agmo-local", ".agents", "plugins", "marketplace.json")), true);
  assert.equal(existsSync(join(tempProject, ".codex", "plugins", "cache", "agmo-local", "agmo", result.plugin_version, ".codex-plugin", "plugin.json")), true);

  const config = await readFile(join(tempProject, ".codex", "config.toml"), "utf8");
  assert.match(config, /\[marketplaces\.agmo-local\]/);
  assert.match(config, /\[plugins\."agmo@agmo-local"\]/);
  assert.match(config, /enabled = true/);
});
