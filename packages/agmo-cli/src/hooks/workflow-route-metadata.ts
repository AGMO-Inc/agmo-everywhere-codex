import type { WorkflowRouteRecord } from "./runtime-state.js";

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

const METADATA_BY_SKILL: Record<string, WorkflowRouteOperationalMetadata> = {
  brainstorming: {
    operational_category: "design",
    recommended_agent: "agmo-planner",
    recommended_effort: "high",
    verification_strategy: "challenge assumptions and hand off only after scope and risks are explicit"
  },
  plan: {
    operational_category: "planning",
    recommended_agent: "agmo-planner",
    recommended_effort: "high",
    verification_strategy: "review acceptance criteria, sequencing, and execution handoff before implementation"
  },
  ralplan: {
    operational_category: "planning",
    recommended_agent: "agmo-planner",
    recommended_effort: "high",
    verification_strategy: "run consensus review against assumptions, options, risks, and test strategy"
  },
  "plan-review": {
    operational_category: "planning",
    recommended_agent: "agmo-critic",
    recommended_effort: "high",
    verification_strategy: "produce an approve, revise, or reject verdict grounded in plan evidence"
  },
  execute: {
    operational_category: "implementation",
    recommended_agent: "agmo-executor",
    recommended_effort: "medium",
    verification_strategy: "run targeted tests plus typecheck/build evidence before claiming completion"
  },
  ralph: {
    operational_category: "implementation",
    recommended_agent: "agmo-executor",
    recommended_effort: "high",
    verification_strategy: "repeat fix and proof until verification passes or a real blocker is documented"
  },
  verify: {
    operational_category: "verification",
    recommended_agent: "agmo-verifier",
    recommended_effort: "medium",
    verification_strategy: "distinguish failed behavior from missing proof with concrete command or diff evidence"
  },
  wisdom: {
    operational_category: "knowledge",
    recommended_agent: "agmo-wisdom",
    recommended_effort: "medium",
    verification_strategy: "separate evidence from inference and preserve source lineage"
  },
  "vault-search": {
    operational_category: "knowledge",
    recommended_agent: "agmo-wisdom",
    recommended_effort: "medium",
    verification_strategy: "return cited durable context and mark unresolved gaps explicitly"
  },
  "save-note": {
    operational_category: "knowledge",
    recommended_agent: "agmo-wisdom",
    recommended_effort: "medium",
    verification_strategy: "verify the save-ready note has reusable structure and source context"
  },
  "git-workflow": {
    operational_category: "repo-ops",
    recommended_agent: "agmo-executor",
    recommended_effort: "medium",
    verification_strategy: "verify git and GitHub command output before reporting branch, commit, push, or PR state"
  },
  "create-issue": {
    operational_category: "issue-ops",
    recommended_agent: "agmo-executor",
    recommended_effort: "medium",
    verification_strategy: "verify the created issue URL and metadata after mutation"
  },
  "note-to-issue": {
    operational_category: "issue-ops",
    recommended_agent: "agmo-executor",
    recommended_effort: "medium",
    verification_strategy: "verify both the source note interpretation and the created GitHub issue"
  }
};

const METADATA_BY_LABEL: Record<string, WorkflowRouteOperationalMetadata> = {
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
  return (
    METADATA_BY_SKILL[route.skill] ??
    METADATA_BY_LABEL[route.label] ??
    METADATA_BY_SKILL.execute
  );
}

export function withOperationalMetadata<T extends WorkflowRouteRecord>(route: T): T {
  return {
    ...route,
    ...metadataForWorkflowRoute(route)
  };
}
