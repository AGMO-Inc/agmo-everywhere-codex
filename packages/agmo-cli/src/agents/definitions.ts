export type AgmoAgentDefinition = {
  name: string;
  description: string;
  promptFile: string;
  legacyNames?: string[];
  model: string;
  modelClass: "frontier" | "standard" | "fast";
  posture: "frontier-orchestrator" | "deep-worker" | "fast-lane";
  reasoningEffort: "low" | "medium" | "high";
};

export const AGMO_AGENT_DEFINITIONS: AgmoAgentDefinition[] = [
  {
    name: "agmo-planner",
    description: "Planning, decomposition, and execution sequencing",
    promptFile: "planner.md",
    model: "gpt-5.5",
    modelClass: "frontier",
    posture: "frontier-orchestrator",
    reasoningEffort: "medium"
  },
  {
    name: "agmo-executor",
    description: "Direct implementation and task completion",
    promptFile: "executor.md",
    model: "gpt-5.5",
    modelClass: "standard",
    posture: "deep-worker",
    reasoningEffort: "medium"
  },
  {
    name: "agmo-verifier",
    description: "Verification, testing, and completion evidence review",
    promptFile: "verifier.md",
    model: "gpt-5.5",
    modelClass: "standard",
    posture: "frontier-orchestrator",
    reasoningEffort: "medium"
  },
  {
    name: "agmo-wisdom",
    description: "Knowledge retrieval and durable note synthesis",
    promptFile: "wisdom.md",
    model: "gpt-5.4-mini",
    modelClass: "fast",
    posture: "fast-lane",
    reasoningEffort: "medium"
  },
  {
    name: "agmo-architect",
    description: "System design, boundaries, interfaces, and tradeoff analysis",
    promptFile: "agmo-architect.md",
    legacyNames: ["architect"],
    model: "gpt-5.5",
    modelClass: "frontier",
    posture: "frontier-orchestrator",
    reasoningEffort: "medium"
  },
  {
    name: "agmo-critic",
    description: "Critical review of plans and designs before execution",
    promptFile: "agmo-critic.md",
    legacyNames: ["critic"],
    model: "gpt-5.5",
    modelClass: "frontier",
    posture: "frontier-orchestrator",
    reasoningEffort: "medium"
  },
  {
    name: "agmo-explore",
    description: "Fast codebase search and file or symbol mapping",
    promptFile: "agmo-explore.md",
    legacyNames: ["explore"],
    model: "gpt-5.3-codex-spark",
    modelClass: "fast",
    posture: "fast-lane",
    reasoningEffort: "low"
  }
];
