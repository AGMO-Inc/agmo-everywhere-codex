import assert from "node:assert/strict";
import os from "node:os";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { buildSetupVaultNotice, installScopedCodexPlugin, resolveSetupScope } from "./setup.js";

async function withIsolatedHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const previousHome = process.env.HOME;
  const previousVaultRoot = process.env.AGMO_VAULT_ROOT;
  const home = await mkdtemp(join(os.tmpdir(), "agmo-setup-home-"));
  process.env.HOME = home;
  delete process.env.AGMO_VAULT_ROOT;

  try {
    return await run(home);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    if (previousVaultRoot === undefined) {
      delete process.env.AGMO_VAULT_ROOT;
    } else {
      process.env.AGMO_VAULT_ROOT = previousVaultRoot;
    }
  }
}

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
  assert.match(
    config,
    /\[tui\]\nstatus_line = \["model-with-reasoning", "current-dir", "context-usage", "five-hour-limit", "weekly-limit"\]/
  );
});

test("installScopedCodexPlugin strips legacy runtime config before writing Agmo plugin settings", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-setup-clean-config-"));
  const configPath = join(tempProject, ".codex", "config.toml");
  mkdirSync(join(tempProject, ".codex"), { recursive: true });
  writeFileSync(
    configPath,
    `# legacy package top-level settings (must be before any [table])
notify = ["node", "/tmp/legacy-runtime/dist/scripts/notify-hook.js"]
developer_instructions = "AGENTS.md is your orchestration brain"

[env]
USE_LEGACY_EXPLORE_CMD = "1"

[mcp_servers.legacy_state]
command = "node"
args = ["/tmp/legacy-runtime/dist/mcp/state-server.js"]
enabled = true

[projects."${tempProject}"]
trust_level = "trusted"
`
  );

  await installScopedCodexPlugin("project", tempProject);

  const config = await readFile(configPath, "utf8");
  assert.doesNotMatch(config, /USE_LEGACY_EXPLORE_CMD|mcp_servers\.legacy_state|notify-hook\.js|AGENTS\.md is your orchestration brain/);
  assert.match(config, /\[projects\./);
  assert.match(config, /\[marketplaces\.agmo-local\]/);
});

test("installScopedCodexPlugin preserves an existing tui status_line", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-setup-existing-status-line-"));
  const configPath = join(tempProject, ".codex", "config.toml");
  mkdirSync(join(tempProject, ".codex"), { recursive: true });
  writeFileSync(
    configPath,
    `[tui]
status_line = ["custom-status", "branch"]
theme = "amber"

[projects."${tempProject}"]
trust_level = "trusted"
`
  );

  await installScopedCodexPlugin("project", tempProject);

  const config = await readFile(configPath, "utf8");
  assert.match(config, /\[tui\]\nstatus_line = \["custom-status", "branch"\]\ntheme = "amber"/);
  assert.doesNotMatch(config, /model-with-reasoning", "current-dir", "context-usage"/);
});

test("buildSetupVaultNotice prompts for vault root when no config exists", async () => {
  await withIsolatedHome(async () => {
    const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-setup-vault-empty-"));
    const notice = await buildSetupVaultNotice("project", tempProject);

    assert.equal(notice.configured, false);
    assert.equal(notice.source, "none");
    assert.equal(notice.vault_root, null);
    assert.equal(
      notice.configure_command,
      'agmo vault config set-root "/path/to/obsidian/vault" --scope project'
    );
    assert.match(notice.note, /Vault is not configured yet/);
  });
});

test("buildSetupVaultNotice reports an existing project vault root", async () => {
  await withIsolatedHome(async () => {
    const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-setup-vault-project-"));
    const vaultRoot = join(tempProject, "obsidian-vault");
    mkdirSync(join(tempProject, ".agmo"), { recursive: true });
    writeFileSync(
      join(tempProject, ".agmo", "config.json"),
      `${JSON.stringify({ vault_root: vaultRoot }, null, 2)}\n`
    );

    const notice = await buildSetupVaultNotice("project", tempProject);

    assert.equal(notice.configured, true);
    assert.equal(notice.source, "project");
    assert.equal(notice.vault_root, vaultRoot);
    assert.equal(notice.note, "Vault is configured from project.");
  });
});
