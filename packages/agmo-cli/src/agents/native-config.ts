import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AGMO_AGENT_DEFINITIONS, type AgmoAgentDefinition } from "./definitions.js";
import { agmoCliPackageRoot } from "../utils/paths.js";

export const MANAGED_PROMPT_MIRROR_FILES = new Set<string>([
  "agmo-architect.md",
  "agmo-critic.md",
  "agmo-explore.md",
  "executor.md",
  "planner.md",
  "verifier.md"
]);

export function promptSourcePath(fileName: string): string {
  const packageRoot = agmoCliPackageRoot();
  const candidates = [
    join(packageRoot, "src", "prompts", fileName),
    join(packageRoot, "dist", "prompts", fileName)
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export function generateStandaloneAgentToml(input: {
  name: string;
  description: string;
  developerInstructions: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
}): string {
  const lines = [
    `name = "${input.name}"`,
    `description = "${input.description}"`,
    input.model ? `model = "${input.model}"` : null,
    input.reasoningEffort
      ? `model_reasoning_effort = "${input.reasoningEffort}"`
      : null,
    'developer_instructions = """',
    input.developerInstructions.trim(),
    '"""'
  ].filter(Boolean);

  return `${lines.join("\n")}\n`;
}

export function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match) {
    return content.trim();
  }

  return content.slice(match[0].length).trim();
}

function composeDeveloperInstructions(
  agent: AgmoAgentDefinition,
  promptContent: string
): string {
  const instructions = stripFrontmatter(promptContent);

  return [
    instructions,
    "",
    "## Agmo Agent Metadata",
    `- role: ${agent.name}`,
    `- posture: ${agent.posture}`,
    `- model_class: ${agent.modelClass}`,
    `- reasoning_effort: ${agent.reasoningEffort}`
  ].join("\n");
}

export async function readPromptContent(fileName: string): Promise<string> {
  return await readFile(promptSourcePath(fileName), "utf-8");
}

export async function buildManagedPromptMirrorMap(): Promise<Record<string, string>> {
  const mirroredEntries = await Promise.all(
    AGMO_AGENT_DEFINITIONS.filter((agent) =>
      MANAGED_PROMPT_MIRROR_FILES.has(agent.promptFile)
    ).map(async (agent) => [agent.promptFile, await readPromptContent(agent.promptFile)] as const)
  );

  return Object.fromEntries(mirroredEntries);
}

export async function buildInitialAgentTomlMap(): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      AGMO_AGENT_DEFINITIONS.map(async (agent) => {
        const promptContent = await readPromptContent(agent.promptFile);

        return [
          agent.name,
          generateStandaloneAgentToml({
            name: agent.name,
            description: agent.description,
            model: agent.model,
            reasoningEffort: agent.reasoningEffort,
            developerInstructions: composeDeveloperInstructions(
              agent,
              promptContent
            )
          })
        ];
      })
    )
  );
}
