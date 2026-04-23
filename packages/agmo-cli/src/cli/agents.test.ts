import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  MANAGED_PROMPT_MIRROR_FILES,
  readPromptContent
} from "../agents/native-config.js";
import { buildAgmoRuntimeConfig } from "../config/generator.js";
import { syncAgents } from "./agents.js";
import { agmoCliPackageRoot, resolveInstallPaths } from "../utils/paths.js";

test("syncAgents writes agmo-prefixed managed agents and removes renamed legacy managed files", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-agents-sync-"));
  const agentsDir = join(tempProject, ".codex", "agents");
  await mkdir(agentsDir, { recursive: true });

  await Promise.all([
    writeFile(join(agentsDir, "architect.toml"), 'name = "architect"\n', "utf-8"),
    writeFile(join(agentsDir, "critic.toml"), 'name = "critic"\n', "utf-8"),
    writeFile(join(agentsDir, "explore.toml"), 'name = "explore"\n', "utf-8"),
    writeFile(join(agentsDir, "custom-agent.toml"), 'name = "custom-agent"\n', "utf-8")
  ]);

  const result = await syncAgents("project", tempProject);

  assert.equal(result.count, 7);
  assert.deepEqual(result.removed_legacy_files, [
    join(agentsDir, "architect.toml"),
    join(agentsDir, "critic.toml"),
    join(agentsDir, "explore.toml")
  ]);

  assert.equal(existsSync(join(agentsDir, "agmo-architect.toml")), true);
  assert.equal(existsSync(join(agentsDir, "agmo-critic.toml")), true);
  assert.equal(existsSync(join(agentsDir, "agmo-explore.toml")), true);

  assert.equal(existsSync(join(agentsDir, "architect.toml")), false);
  assert.equal(existsSync(join(agentsDir, "critic.toml")), false);
  assert.equal(existsSync(join(agentsDir, "explore.toml")), false);

  assert.equal(existsSync(join(agentsDir, "custom-agent.toml")), true);
});

test("syncAgents embeds expanded managed prompt contracts into generated agent TOMLs", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-agents-prompts-"));

  await syncAgents("project", tempProject);

  const readAgent = (name: string) =>
    readFileSync(join(tempProject, ".codex", "agents", `${name}.toml`), "utf-8");

  const architect = readAgent("agmo-architect");
  assert.match(architect, /<identity>/);
  assert.match(architect, /## Summary/);
  assert.match(architect, /## Agmo Agent Metadata/);

  const planner = readAgent("agmo-planner");
  assert.match(planner, /Plan Summary/);
  assert.match(planner, /RALPLAN-DR/);

  const executor = readAgent("agmo-executor");
  assert.match(executor, /KEEP GOING UNTIL THE TASK IS FULLY RESOLVED\./);
  assert.match(executor, /## Verification/);

  const wisdom = readAgent("agmo-wisdom");
  assert.match(wisdom, /## Save-ready Note Proposal/);
  assert.match(wisdom, /canonical note/);
});

test("syncAgents mirrors shared managed prompt files into project .codex/prompts", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-agent-prompt-mirror-"));

  await syncAgents("project", tempProject);

  for (const fileName of MANAGED_PROMPT_MIRROR_FILES) {
    const mirrored = readFileSync(
      join(tempProject, ".codex", "prompts", fileName),
      "utf-8"
    );
    const source = await readPromptContent(fileName);
    assert.equal(mirrored, source, `${fileName} should mirror the package prompt source`);
  }
});

test("checked-in .codex prompt mirrors stay aligned with package prompt sources", async () => {
  const repoRoot = resolve(agmoCliPackageRoot(), "..", "..");

  for (const fileName of MANAGED_PROMPT_MIRROR_FILES) {
    const checkedInMirror = readFileSync(
      join(repoRoot, ".codex", "prompts", fileName),
      "utf-8"
    );
    const source = await readPromptContent(fileName);
    assert.equal(
      checkedInMirror,
      source,
      `${fileName} in .codex/prompts drifted from packages/agmo-cli/src/prompts`
    );
  }
});

test("runtime config publishes the managed prompts directory", () => {
  const tempProject = "/tmp/agmo-runtime-config-prompts";
  const paths = resolveInstallPaths("project", tempProject);
  const config = buildAgmoRuntimeConfig("project", paths);
  const runtimePaths = config.paths as Record<string, unknown>;

  assert.equal(runtimePaths.prompts_dir, join(tempProject, ".codex", "prompts"));
});
