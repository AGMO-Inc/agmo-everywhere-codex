export type AgmoTaskIntent =
  | "implementation"
  | "verification"
  | "planning"
  | "knowledge";

export type AgmoTaskRoutingResult = {
  role: string;
  confidence: "low" | "medium";
  reason: string;
  intent: AgmoTaskIntent;
};

export type AgmoInitialTaskLane = {
  role: string;
  lane: "plan" | "implement" | "verify" | "knowledge";
  summary: string;
  dependsOn: number[];
  requiresCodeChange: boolean;
  overrideReason?: string;
};

function containsAny(normalizedTask: string, keywords: string[]): boolean {
  return keywords.some((keyword) => normalizedTask.includes(keyword));
}

export function routeTaskToRole(task: string): AgmoTaskRoutingResult {
  const normalized = task.toLowerCase();

  if (
    containsAny(normalized, [
      "test",
      "verify",
      "validation",
      "validate",
      "regression",
      "qa"
    ])
  ) {
    return {
      role: "agmo-verifier",
      intent: "verification",
      confidence: "medium",
      reason: "verification-oriented keywords detected"
    };
  }

  if (
    containsAny(normalized, [
      "plan",
      "design",
      "architecture",
      "architect",
      "decompose",
      "strategy"
    ])
  ) {
    return {
      role: "agmo-planner",
      intent: "planning",
      confidence: "medium",
      reason: "planning-oriented keywords detected"
    };
  }

  if (
    containsAny(normalized, [
      "implement",
      "implementation",
      "build",
      "fix",
      "improve",
      "refactor",
      "support",
      "wire",
      "integrate",
      "ship"
    ])
  ) {
    return {
      role: "agmo-executor",
      intent: "implementation",
      confidence: "medium",
      reason: "implementation-oriented keywords detected"
    };
  }

  if (
    containsAny(normalized, [
      "research",
      "docs",
      "document",
      "documentation",
      "obsidian",
      "vault",
      "note",
      "memo",
      "knowledge"
    ])
  ) {
    return {
      role: "agmo-wisdom",
      intent: "knowledge",
      confidence: "medium",
      reason: "knowledge/vault-oriented keywords detected"
    };
  }

  return {
    role: "agmo-executor",
    intent: "implementation",
    confidence: "low",
    reason: "fallback implementation lane"
  };
}

function buildImplementationLanes(workerCount: number, normalizedTask: string): AgmoInitialTaskLane[] {
  const includeKnowledge = workerCount >= 4 && containsAny(normalizedTask, [
    "obsidian",
    "vault",
    "docs",
    "document",
    "research",
    "note"
  ]);

  if (workerCount === 1) {
    return [
      {
        role: "agmo-executor",
        lane: "implement",
        summary: "Implement the main task directly and keep durable progress notes.",
        dependsOn: [],
        requiresCodeChange: true
      }
    ];
  }

  if (workerCount === 2) {
    return [
      {
        role: "agmo-executor",
        lane: "implement",
        summary: "Implement the primary solution slice.",
        dependsOn: [],
        requiresCodeChange: true
      },
      {
        role: "agmo-verifier",
        lane: "verify",
        summary: "Validate implementation quality, test behavior, and capture completion evidence.",
        dependsOn: [1],
        requiresCodeChange: false
      }
    ];
  }

  const lanes: AgmoInitialTaskLane[] = [
    {
      role: "agmo-planner",
      lane: "plan",
      summary: "Decompose the task, identify files/risks, and shape the execution plan for the team.",
      dependsOn: [],
      requiresCodeChange: false
    }
  ];

  const remainingWorkers = workerCount - 2;
  const executorSlots = includeKnowledge ? Math.max(1, remainingWorkers - 1) : remainingWorkers;
  for (let index = 0; index < executorSlots; index += 1) {
    lanes.push({
      role: "agmo-executor",
      lane: "implement",
      summary:
        executorSlots > 1
          ? `Implement execution slice ${index + 1}/${executorSlots} in the isolated worktree.`
          : "Implement the main execution slice in the isolated worktree.",
      dependsOn: [1],
      requiresCodeChange: true
    });
  }

  if (includeKnowledge) {
    lanes.push({
      role: "agmo-wisdom",
      lane: "knowledge",
      summary:
        "Track vault/docs/research implications, preserve useful notes, and surface durable references.",
      dependsOn: [1],
      requiresCodeChange: false
    });
  }

  lanes.push({
    role: "agmo-verifier",
    lane: "verify",
    summary: "Verify implementation results, run tests/checks, and capture evidence or regressions.",
    dependsOn: lanes
      .map((_, index) => index + 1)
      .filter((taskId) => taskId !== 1 && taskId !== lanes.length + 1),
    requiresCodeChange: false
  });

  return lanes.slice(0, workerCount);
}

function buildPlanningLanes(workerCount: number): AgmoInitialTaskLane[] {
  const lanes: AgmoInitialTaskLane[] = [
    {
      role: "agmo-planner",
      lane: "plan",
      summary: "Own the main decomposition, sequencing, and decision framing.",
      dependsOn: [],
      requiresCodeChange: false
    }
  ];

  if (workerCount >= 2) {
    lanes.push({
      role: "agmo-wisdom",
      lane: "knowledge",
      summary: "Gather references, constraints, prior notes, and useful supporting context.",
      dependsOn: [],
      requiresCodeChange: false
    });
  }

  for (let index = lanes.length; index < workerCount; index += 1) {
    lanes.push({
      role: index === workerCount - 1 ? "agmo-verifier" : "agmo-executor",
      lane: index === workerCount - 1 ? "verify" : "implement",
      summary:
        index === workerCount - 1
          ? "Review the final plan for consistency, gaps, and acceptance criteria."
          : `Turn plan slice ${index}/${workerCount - 1} into concrete implementation-ready detail.`,
      dependsOn: [1],
      requiresCodeChange: false
    });
  }

  return lanes.slice(0, workerCount);
}

function buildVerificationLanes(workerCount: number): AgmoInitialTaskLane[] {
  if (workerCount === 1) {
    return [
      {
        role: "agmo-verifier",
        lane: "verify",
        summary: "Own verification directly and capture failures or evidence.",
        dependsOn: [],
        requiresCodeChange: false
      }
    ];
  }

  const lanes: AgmoInitialTaskLane[] = [
    {
      role: "agmo-verifier",
      lane: "verify",
      summary: "Lead the verification plan, acceptance criteria, and evidence collection.",
      dependsOn: [],
      requiresCodeChange: false
    },
    {
      role: "agmo-executor",
      lane: "implement",
      summary: "Handle implementation fixes or instrumentation requested by verification.",
      dependsOn: [1],
      requiresCodeChange: true
    }
  ];

  for (let index = lanes.length; index < workerCount; index += 1) {
    lanes.push({
      role: index === workerCount - 1 ? "agmo-planner" : "agmo-verifier",
      lane: index === workerCount - 1 ? "plan" : "verify",
      summary:
        index === workerCount - 1
          ? "Track risks, regression priorities, and verification sequencing."
          : `Run additional verification slice ${index}/${workerCount}.`,
      dependsOn: [],
      requiresCodeChange: false
    });
  }

  return lanes.slice(0, workerCount);
}

function buildKnowledgeLanes(workerCount: number): AgmoInitialTaskLane[] {
  const lanes: AgmoInitialTaskLane[] = [
    {
      role: "agmo-wisdom",
      lane: "knowledge",
      summary: "Lead note/doc/vault synthesis and preserve durable knowledge artifacts.",
      dependsOn: [],
      requiresCodeChange: false
    }
  ];

  if (workerCount >= 2) {
    lanes.push({
      role: "agmo-planner",
      lane: "plan",
      summary: "Structure the research/doc output into a clear delivery outline.",
      dependsOn: [1],
      requiresCodeChange: false
    });
  }

  for (let index = lanes.length; index < workerCount; index += 1) {
    lanes.push({
      role: index === workerCount - 1 ? "agmo-verifier" : "agmo-executor",
      lane: index === workerCount - 1 ? "verify" : "implement",
      summary:
        index === workerCount - 1
          ? "Review the note/doc output for completeness, linking quality, and correctness."
          : `Produce supporting artifact slice ${index}/${workerCount}.`,
      dependsOn: [1, ...(workerCount >= 2 ? [2] : [])],
      requiresCodeChange: false
    });
  }

  return lanes.slice(0, workerCount);
}

export function buildInitialTaskLanes(task: string, workerCount: number): {
  routing: AgmoTaskRoutingResult;
  lanes: AgmoInitialTaskLane[];
} {
  return buildInitialTaskLanesWithOverrides(task, workerCount);
}

export function buildInitialTaskLanesWithOverrides(
  task: string,
  workerCount: number,
  options: {
    intentOverride?: AgmoTaskIntent;
    roleOverridesByIndex?: Record<number, string>;
  } = {}
): {
  routing: AgmoTaskRoutingResult;
  lanes: AgmoInitialTaskLane[];
} {
  const routing = routeTaskToRole(task);
  const normalizedTask = task.toLowerCase();
  const effectiveIntent = options.intentOverride ?? routing.intent;

  const lanes =
    effectiveIntent === "planning"
      ? buildPlanningLanes(workerCount)
      : effectiveIntent === "verification"
        ? buildVerificationLanes(workerCount)
        : effectiveIntent === "knowledge"
          ? buildKnowledgeLanes(workerCount)
          : buildImplementationLanes(workerCount, normalizedTask);

  const nextRouting =
    options.intentOverride && options.intentOverride !== routing.intent
      ? {
          ...routing,
          intent: options.intentOverride,
          role: lanes[0]?.role ?? routing.role,
          reason: `intent override applied (${options.intentOverride})`
        }
      : routing;
  const nextLanes = lanes.map((lane, index) => {
    const overrideRole = options.roleOverridesByIndex?.[index + 1];
    if (!overrideRole) {
      return lane;
    }
    return {
      ...lane,
      role: overrideRole,
      overrideReason: `role override applied (${overrideRole})`
    };
  });

  return { routing: nextRouting, lanes: nextLanes };
}
