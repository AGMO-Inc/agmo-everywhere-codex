import assert from "node:assert/strict";
import os from "node:os";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { validatePluginBundle } from "./validate-plugin.mjs";

test("validates the checked-in plugin bundle", async () => {
  const repoRoot = resolve(new URL("..", import.meta.url).pathname);
  const issues = await validatePluginBundle(repoRoot);
  assert.deepEqual(issues, []);
});

test("reports plugin version mismatches", async () => {
  const repoRoot = await mkdtemp(resolve(os.tmpdir(), "agmo-plugin-validate-"));
  await mkdir(resolve(repoRoot, "packages/agmo-plugin/.codex-plugin"), { recursive: true });
  await mkdir(resolve(repoRoot, "packages/agmo-plugin/skills/example"), { recursive: true });
  await mkdir(resolve(repoRoot, "packages/agmo-plugin/assets"), { recursive: true });
  await mkdir(resolve(repoRoot, ".codex/skills/example"), { recursive: true });

  await writeFile(
    resolve(repoRoot, "packages/agmo-plugin/package.json"),
    `${JSON.stringify(
      {
        name: "@agmo/plugin",
        version: "0.1.0",
        scripts: {}
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    resolve(repoRoot, "packages/agmo-plugin/.codex-plugin/plugin.json"),
    `${JSON.stringify(
      {
        name: "agmo",
        version: "0.1.1",
        description: "Agmo",
        skills: "./skills/",
        mcpServers: "./.mcp.json",
        interface: { label: "Agmo" }
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    resolve(repoRoot, "packages/agmo-plugin/.mcp.json"),
    `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`
  );
  await writeFile(resolve(repoRoot, "packages/agmo-plugin/skills/example/SKILL.md"), "---\nname: example\n---\n");
  await writeFile(resolve(repoRoot, ".codex/skills/example/SKILL.md"), "---\nname: example\n---\n");

  const issues = await validatePluginBundle(repoRoot);
  assert.equal(
    issues.includes(
      "plugin package version 0.1.0 does not match plugin manifest version 0.1.1"
    ),
    true
  );
});
