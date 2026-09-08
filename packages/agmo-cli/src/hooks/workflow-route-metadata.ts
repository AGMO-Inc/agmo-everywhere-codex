import type { WorkflowRouteRecord } from "./runtime-state.js";
import { AGMO_AGENT_DEFINITIONS } from "../agents/definitions.js";

export type WorkflowOperationalCategory = NonNullable<
  WorkflowRouteRecord["operational_category"]
>;

export type WorkflowRouteOperationalMetadata = Required<
  Pick<
    WorkflowRouteRecord,
    | "operational_category"
    | "recommended_agent"
    | "recommended_effort"
    | "verification_strategy"
  >
>;

type WorkflowRouteBaseOperationalMetadata = Omit<
  WorkflowRouteOperationalMetadata,
  "recommended_effort"
>;

const METADATA_BY_SKILL: Record<string, WorkflowRouteBaseOperationalMetadata> = {
  brainstorming: {
    operational_category: "design",
    recommended_agent: "agmo-planner",
    verification_strategy: "challenge assumptions and hand off only after scope and risks are explicit"
  },
  plan: {
    operational_category: "planning",
    recommended_agent: "agmo-planner",
    verification_strategy: "review acceptance criteria, sequencing, and execution handoff before implementation"
  },
  ralplan: {
    operational_category: "planning",
    recommended_agent: "agmo-planner",
    verification_strategy: "run consensus review against assumptions, options, risks, and test strategy"
  },
  "plan-review": {
    operational_category: "planning",
    recommended_agent: "agmo-critic",
    verification_strategy: "produce an approve, revise, or reject verdict grounded in plan evidence"
  },
  "code-review": {
    operational_category: "verification",
    recommended_agent: "agmo-critic",
    verification_strategy: "report severity-ranked findings and use verifier evidence before concluding the review"
  },
  execute: {
    operational_category: "implementation",
    recommended_agent: "agmo-executor",
    verification_strategy: "run targeted tests plus typecheck/build evidence before claiming completion"
  },
  ralph: {
    operational_category: "implementation",
    recommended_agent: "agmo-executor",
    verification_strategy: "repeat fix and proof until verification passes or a real blocker is documented"
  },
  verify: {
    operational_category: "verification",
    recommended_agent: "agmo-verifier",
    verification_strategy: "distinguish failed behavior from missing proof with concrete command or diff evidence"
  },
  wisdom: {
    operational_category: "knowledge",
    recommended_agent: "agmo-wisdom",
    verification_strategy: "separate evidence from inference and preserve source lineage"
  },
  "vault-search": {
    operational_category: "knowledge",
    recommended_agent: "agmo-wisdom",
    verification_strategy: "return cited durable context and mark unresolved gaps explicitly"
  },
  "save-note": {
    operational_category: "knowledge",
    recommended_agent: "agmo-wisdom",
    verification_strategy: "verify the save-ready note has reusable structure and source context"
  },
  "git-workflow": {
    operational_category: "repo-ops",
    recommended_agent: "agmo-executor",
    verification_strategy: "verify git and GitHub command output before reporting branch, commit, push, or PR state"
  },
  "create-issue": {
    operational_category: "issue-ops",
    recommended_agent: "agmo-executor",
    verification_strategy: "verify the created issue URL and metadata after mutation"
  },
  "note-to-issue": {
    operational_category: "issue-ops",
    recommended_agent: "agmo-executor",
    verification_strategy: "verify both the source note interpretation and the created GitHub issue"
  }
};

const METADATA_BY_LABEL: Record<string, WorkflowRouteBaseOperationalMetadata> = {
  brainstorming: METADATA_BY_SKILL.brainstorming,
  plan: METADATA_BY_SKILL.plan,
  execute: METADATA_BY_SKILL.execute,
  verify: METADATA_BY_SKILL.verify,
  wisdom: METADATA_BY_SKILL.wisdom,
  "vault-search": METADATA_BY_SKILL["vault-search"],
  "save-note": METADATA_BY_SKILL["save-note"],
  "git-workflow": METADATA_BY_SKILL["git-workflow"],
  "create-issue": METADATA_BY_SKILL["create-issue"],
  "note-to-issue": METADATA_BY_SKILL["note-to-issue"]
};

export function metadataForWorkflowRoute(
  route: Pick<WorkflowRouteRecord, "skill" | "label">
): WorkflowRouteOperationalMetadata {
  const metadata = (
    METADATA_BY_SKILL[route.skill] ??
    METADATA_BY_LABEL[route.label] ??
    METADATA_BY_SKILL.execute
  );
  const agent = AGMO_AGENT_DEFINITIONS.find(
    (definition) => definition.name === metadata.recommended_agent
  );
  if (!agent) {
    throw new Error(`missing Agmo agent definition for ${metadata.recommended_agent}`);
  }

  return {
    ...metadata,
    recommended_effort: agent.reasoningEffort
  };
}

export function withOperationalMetadata<T extends WorkflowRouteRecord>(route: T): T {
  return {
    ...route,
    ...metadataForWorkflowRoute(route)
  };
}
