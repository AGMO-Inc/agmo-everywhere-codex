import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AGMO_AGENT_DEFINITIONS, type AgmoAgentDefinition } from "./definitions.js";
import { agmoCliPackageRoot } from "../utils/paths.js";

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

async function readPromptContent(fileName: string): Promise<string> {
  const promptPath = join(agmoCliPackageRoot(), "src", "prompts", fileName);
  return await readFile(promptPath, "utf-8");
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
