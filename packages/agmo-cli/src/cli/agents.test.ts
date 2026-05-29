import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  MANAGED_PROMPT_MIRROR_FILES,
  buildInitialAgentTomlMap,
  listManagedSkillMirrorNames,
  readPromptContent,
  readSkillContent,
} from "../agents/native-config.js";
import { AGMO_AGENT_DEFINITIONS } from "../agents/definitions.js";
import { buildAgmoRuntimeConfig } from "../config/generator.js";
import { syncAgents } from "./agents.js";
import { agmoCliPackageRoot, resolveInstallPaths } from "../utils/paths.js";

function parseGeneratedAgentToml(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const tripleQuoted = line.match(/^([A-Za-z0-9_-]+) = """$/);
    if (tripleQuoted) {
      const valueLines: string[] = [];
      index += 1;
      while (index < lines.length && lines[index] !== '"""') {
        valueLines.push(lines[index] ?? "");
        index += 1;
      }
      assert.equal(lines[index], '"""', `${tripleQuoted[1]} should close triple-quoted TOML`);
      parsed[tripleQuoted[1] ?? ""] = valueLines.join("\n");
      continue;
    }

    const quoted = line.match(/^([A-Za-z0-9_-]+) = "([^"]*)"$/);
    if (quoted) {
      parsed[quoted[1] ?? ""] = quoted[2] ?? "";
    }
  }

  return parsed;
}

test("syncAgents writes agmo-prefixed managed agents and removes renamed legacy managed files", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-agents-sync-"));
  const agentsDir = join(tempProject, ".codex", "agents");
  await mkdir(agentsDir, { recursive: true });

  await Promise.all([
    writeFile(
      join(agentsDir, "architect.toml"),
      'name = "architect"\n',
      "utf-8",
    ),
    writeFile(join(agentsDir, "critic.toml"), 'name = "critic"\n', "utf-8"),
    writeFile(join(agentsDir, "explore.toml"), 'name = "explore"\n', "utf-8"),
    writeFile(
      join(agentsDir, "custom-agent.toml"),
      'name = "custom-agent"\n',
      "utf-8",
    ),
  ]);

  const result = await syncAgents("project", tempProject);

  assert.equal(result.count, 7);
  assert.deepEqual(result.removed_legacy_files, [
    join(agentsDir, "architect.toml"),
    join(agentsDir, "critic.toml"),
    join(agentsDir, "explore.toml"),
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
    readFileSync(
      join(tempProject, ".codex", "agents", `${name}.toml`),
      "utf-8",
    );

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

test("managed native agent TOMLs keep expected defaults and remain parseable", async () => {
  const agentTomls = await buildInitialAgentTomlMap();

  const expectedDefaults = {
    "agmo-planner": {
      model: "gpt-5.5",
      model_reasoning_effort: "medium",
      posture: "frontier-orchestrator",
      modelClass: "frontier",
    },
    "agmo-executor": {
      model: "gpt-5.5",
      model_reasoning_effort: "medium",
      posture: "deep-worker",
      modelClass: "standard",
    },
    "agmo-verifier": {
      model: "gpt-5.5",
      model_reasoning_effort: "medium",
      posture: "frontier-orchestrator",
      modelClass: "standard",
    },
    "agmo-wisdom": {
      model: "gpt-5.4-mini",
      model_reasoning_effort: "medium",
      posture: "fast-lane",
      modelClass: "fast",
    },
    "agmo-architect": {
      model: "gpt-5.5",
      model_reasoning_effort: "medium",
      posture: "frontier-orchestrator",
      modelClass: "frontier",
    },
    "agmo-critic": {
      model: "gpt-5.5",
      model_reasoning_effort: "medium",
      posture: "frontier-orchestrator",
      modelClass: "frontier",
    },
    "agmo-explore": {
      model: "gpt-5.3-codex-spark",
      model_reasoning_effort: "low",
      posture: "fast-lane",
      modelClass: "fast",
    },
  };

  assert.deepEqual(
    Object.keys(expectedDefaults).sort(),
    AGMO_AGENT_DEFINITIONS.map((agent) => agent.name).sort(),
  );

  for (const [agentName, expected] of Object.entries(expectedDefaults)) {
    const parsed = parseGeneratedAgentToml(agentTomls[agentName] ?? "");
    assert.equal(parsed.name, agentName);
    assert.equal(parsed.model, expected.model);
    assert.equal(parsed.model_reasoning_effort, expected.model_reasoning_effort);
    assert.match(parsed.description, /\S/);
    assert.match(parsed.developer_instructions, /## Agmo Agent Metadata/);
    assert.match(parsed.developer_instructions, new RegExp(`- role: ${agentName}`));
    assert.match(
      parsed.developer_instructions,
      new RegExp(`- posture: ${expected.posture}`),
    );
    assert.match(
      parsed.developer_instructions,
      new RegExp(`- model_class: ${expected.modelClass}`),
    );
    assert.match(
      parsed.developer_instructions,
      new RegExp(`- reasoning_effort: ${expected.model_reasoning_effort}`),
    );
  }
});

test("syncAgents mirrors shared managed prompt files into project .codex/prompts", async () => {
  const tempProject = await mkdtemp(
    join(os.tmpdir(), "agmo-agent-prompt-mirror-"),
  );

  await syncAgents("project", tempProject);

  for (const fileName of MANAGED_PROMPT_MIRROR_FILES) {
    const mirrored = readFileSync(
      join(tempProject, ".codex", "prompts", fileName),
      "utf-8",
    );
    const source = await readPromptContent(fileName);
    assert.equal(
      mirrored,
      source,
      `${fileName} should mirror the package prompt source`,
    );
  }
});

test("checked-in .codex prompt mirrors stay aligned with package prompt sources", async () => {
  const repoRoot = resolve(agmoCliPackageRoot(), "..", "..");

  for (const fileName of MANAGED_PROMPT_MIRROR_FILES) {
    const checkedInMirror = readFileSync(
      join(repoRoot, ".codex", "prompts", fileName),
      "utf-8",
    );
    const source = await readPromptContent(fileName);
    assert.equal(
      checkedInMirror,
      source,
      `${fileName} in .codex/prompts drifted from packages/agmo-cli/src/prompts`,
    );
  }
});

test("syncAgents mirrors managed Agmo skills into project .codex/skills", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-skill-mirror-"));

  await syncAgents("project", tempProject);

  for (const skillName of await listManagedSkillMirrorNames()) {
    const mirrored = readFileSync(
      join(tempProject, ".codex", "skills", skillName, "SKILL.md"),
      "utf-8",
    );
    const source = await readSkillContent(skillName);
    assert.equal(
      mirrored,
      source,
      `${skillName} should mirror the packaged skill source`,
    );
  }
});

test("checked-in .codex skill mirrors stay aligned with packaged Agmo skill sources", async () => {
  const repoRoot = resolve(agmoCliPackageRoot(), "..", "..");

  for (const skillName of await listManagedSkillMirrorNames()) {
    const checkedInMirror = readFileSync(
      join(repoRoot, ".codex", "skills", skillName, "SKILL.md"),
      "utf-8",
    );
    const source = await readSkillContent(skillName);
    assert.equal(
      checkedInMirror,
      source,
      `${skillName} in .codex/skills drifted from packages/agmo-plugin/skills`,
    );
  }
});

test("managed agent prompt contracts preserve role boundaries and critical guidance", async () => {
  const prompts: Record<string, string> = Object.fromEntries(
    await Promise.all(
      AGMO_AGENT_DEFINITIONS.map(async (agent) => [
        agent.promptFile,
        await readPromptContent(agent.promptFile),
      ]),
    ),
  );

  assert.match(prompts["planner.md"] ?? "", /You plan\. You do not implement\./);
  assert.match(prompts["planner.md"] ?? "", /Do not write code files\./);

  assert.match(prompts["executor.md"] ?? "", /Explore, implement, verify, and finish\./);
  assert.match(prompts["executor.md"] ?? "", /No evidence = not complete\./);
  assert.match(prompts["executor.md"] ?? "", /When committing code, follow the Lore commit protocol/);
  for (const [promptFile, prompt] of Object.entries(prompts)) {
    if (promptFile !== "executor.md") {
      assert.doesNotMatch(prompt, /Lore commit protocol/i, `${promptFile} should not carry Lore commit guidance`);
    }
  }

  assert.match(prompts["agmo-architect.md"] ?? "", /You are read-only\./);
  assert.match(prompts["agmo-architect.md"] ?? "", /Never write or edit files\./);
  assert.match(prompts["agmo-critic.md"] ?? "", /Read-only: Write and Edit tools are blocked\./);
  assert.match(prompts["agmo-critic.md"] ?? "", /not responsible.*implementing changes/s);
  assert.match(prompts["agmo-explore.md"] ?? "", /Read-only: you cannot create, modify, or delete files\./);
  assert.match(prompts["agmo-explore.md"] ?? "", /not responsible for modifying code, implementing features/);

  assert.match(prompts["verifier.md"] ?? "", /Distinguish missing evidence from failed behavior\./);
  assert.match(prompts["verifier.md"] ?? "", /Did I call out missing proof clearly\?/);

  assert.match(prompts["wisdom.md"] ?? "", /Separate facts, inference, and save proposals\./);
  assert.match(prompts["wisdom.md"] ?? "", /explicit evidence vs inference/);
});

test("runtime config publishes the managed prompt and skill directories", () => {
  const tempProject = "/tmp/agmo-runtime-config-prompts";
  const paths = resolveInstallPaths("project", tempProject);
  const config = buildAgmoRuntimeConfig("project", paths);
  const runtimePaths = config.paths as Record<string, unknown>;

  assert.equal(
    runtimePaths.prompts_dir,
    join(tempProject, ".codex", "prompts"),
  );
  assert.equal(runtimePaths.skills_dir, join(tempProject, ".codex", "skills"));
});
