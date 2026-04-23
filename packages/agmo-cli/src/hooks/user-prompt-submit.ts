import {
  readPersistedSessionState,
  readPromptText,
  type SessionState,
  type AgmoHookPayload,
  writeWorkflowActivation
} from "./runtime-state.js";
import { saveSessionCheckpointNote } from "../vault/checkpoint.js";
import { escalateToSameSessionTeam } from "../team/escalation.js";
import type { AgmoTeamEscalationResult } from "../team/escalation.js";

type WorkflowRoute = {
  skill: string;
  label: string;
  reason: string;
};

type ScoredPattern = {
  pattern: RegExp;
  score: number;
};

const CONTINUATION_PATTERNS: RegExp[] = [
  /^계속/u,
  /^이어(?:서|가자|줘)?/u,
  /^전부/u,
  /\bcontinue\b/i,
  /\bresume\b/i,
  /\bkeep going\b/i
];

const EXPLICIT_ROUTE_OVERRIDES: Array<{
  pattern: RegExp;
  route: WorkflowRoute;
}> = [
  {
    pattern: /^\$vault-search\b/i,
    route: {
      skill: "vault-search",
      label: "vault-search",
      reason: "explicit $vault-search invocation"
    }
  },
  {
    pattern: /^\$save-note\b/i,
    route: {
      skill: "save-note",
      label: "save-note",
      reason: "explicit $save-note invocation"
    }
  },
  {
    pattern: /^\$wisdom\b/i,
    route: {
      skill: "wisdom",
      label: "wisdom",
      reason: "explicit $wisdom invocation"
    }
  },
  {
    pattern: /^\$plan-review\b/i,
    route: {
      skill: "plan-review",
      label: "plan",
      reason: "explicit $plan-review invocation"
    }
  },
  {
    pattern: /^\$verify\b/i,
    route: {
      skill: "verify",
      label: "verify",
      reason: "explicit $verify invocation"
    }
  },
  {
    pattern: /^\$(?:brainstorm(?:ing)?|design)\b/i,
    route: {
      skill: "brainstorming",
      label: "brainstorming",
      reason: "explicit brainstorming invocation or design alias"
    }
  },
  {
    pattern: /^\$?ralplan\b/i,
    route: {
      skill: "ralplan",
      label: "plan",
      reason: "explicit ralplan compatibility alias invocation"
    }
  },
  {
    pattern: /^\$plan\b/i,
    route: {
      skill: "plan",
      label: "plan",
      reason: "explicit $plan invocation"
    }
  },
  {
    pattern: /^\$execute\b/i,
    route: {
      skill: "execute",
      label: "execute",
      reason: "explicit $execute invocation"
    }
  }
];

const ROUTES: Array<{
  route: WorkflowRoute;
  patterns: ScoredPattern[];
}> = [
  {
    route: {
      skill: "vault-search",
      label: "vault-search",
      reason: "vault/Obsidian note retrieval request"
    },
    patterns: [
      { pattern: /\$?vault-search\b/i, score: 6 },
      { pattern: /\b(search|find|read|open)\b.*\b(vault|obsidian|note|document)\b/i, score: 5 },
      { pattern: /\b(vault|obsidian)\b.*\b(search|find|read|open)\b/i, score: 5 },
      { pattern: /\b(previous|prior|past)\b.*\b(note|decision|plan|design|implementation)\b/i, score: 5 },
      { pattern: /옵시디언.*(찾|검색|열어|읽)/u, score: 5 },
      { pattern: /(이전|예전|과거).*(노트|결정|플랜|계획|설계|구현)/u, score: 5 },
      { pattern: /(문서|노트).*(찾|검색|열어|읽)/u, score: 4 }
    ]
  },
  {
    route: {
      skill: "save-note",
      label: "save-note",
      reason: "durable note persistence request"
    },
    patterns: [
      { pattern: /\$?save-note\b/i, score: 6 },
      { pattern: /\b(save|persist|archive|record)\b.*\b(note|memo|decision)\b/i, score: 5 },
      { pattern: /\b(checkpoint|decision record)\b/i, score: 5 },
      { pattern: /(노트|메모|회의록|결정).*(저장|기록|남겨)/u, score: 5 },
      { pattern: /(체크포인트|결정사항|요약).*(저장|기록|남겨)/u, score: 5 },
      { pattern: /\bobsidian\b.*\b(save|record)\b/i, score: 4 },
      { pattern: /옵시디언.*(저장|기록)/u, score: 4 }
    ]
  },
  {
    route: {
      skill: "wisdom",
      label: "wisdom",
      reason: "knowledge/doc/research-oriented request"
    },
    patterns: [
      { pattern: /\$?wisdom\b/i, score: 6 },
      { pattern: /\bresearch\b/i, score: 5 },
      { pattern: /\b(summarize|synthesis|synthesize|compare|comparison)\b/i, score: 5 },
      { pattern: /\bdocs?\b/i, score: 3 },
      { pattern: /\bknowledge\b/i, score: 4 },
      { pattern: /리서치|조사|지식/u, score: 4 },
      { pattern: /요약|정리|비교|분석/u, score: 4 },
      { pattern: /문서.*(요약|정리|비교)/u, score: 4 }
    ]
  },
  {
    route: {
      skill: "plan-review",
      label: "plan",
      reason: "plan review request while preserving plan workflow context"
    },
    patterns: [
      { pattern: /\$?plan-review\b/i, score: 8 },
      { pattern: /\$?plan\b.*--review\b/i, score: 8 },
      { pattern: /\breview\b.*\bplan\b/i, score: 6 },
      { pattern: /\bplan\b.*\breview\b/i, score: 6 },
      { pattern: /(?:플랜|계획).*(?:리뷰|검토|비평)/u, score: 6 }
    ]
  },
  {
    route: {
      skill: "verify",
      label: "verify",
      reason: "verification/test/review-oriented request"
    },
    patterns: [
      { pattern: /\$?verify\b/i, score: 7 },
      { pattern: /\bverify\b/i, score: 5 },
      { pattern: /\btest\b/i, score: 4 },
      { pattern: /\breview\b/i, score: 4 },
      { pattern: /검증|테스트|확인|리뷰/u, score: 4 }
    ]
  },
  {
    route: {
      skill: "brainstorming",
      label: "brainstorming",
      reason: "brainstorming exploration request or design alias"
    },
    patterns: [
      { pattern: /\$?(?:brainstorm(?:ing)?|design)\b/i, score: 7 },
      { pattern: /\bbrainstorm\b/i, score: 5 },
      { pattern: /\bidea\b/i, score: 4 },
      { pattern: /\bdesign\b/i, score: 3 },
      { pattern: /브레인스토밍|아이디어|논의|초안/u, score: 5 },
      { pattern: /설계/u, score: 3 }
    ]
  },
  {
    route: {
      skill: "ralplan",
      label: "plan",
      reason: "consensus-oriented planning request via compatibility alias"
    },
    patterns: [
      { pattern: /\$?ralplan\b/i, score: 8 },
      { pattern: /\b(?:consensus|high-trust)\b.*\bplan\b/i, score: 6 },
      { pattern: /\bplan\b.*\b(?:consensus|high-trust)\b/i, score: 6 },
      { pattern: /(?:합의형|컨센서스|고신뢰).*(?:플랜|계획)/u, score: 6 }
    ]
  },
  {
    route: {
      skill: "plan",
      label: "plan",
      reason: "planning/decomposition-oriented request"
    },
    patterns: [
      { pattern: /\$?plan\b/i, score: 6 },
      { pattern: /\bplan\b/i, score: 5 },
      { pattern: /\bstrategy\b/i, score: 4 },
      { pattern: /\bbreak down\b/i, score: 4 },
      { pattern: /\btodo\b/i, score: 3 },
      { pattern: /계획|분해|전략|작업 계획|단계/u, score: 4 }
    ]
  },
  {
    route: {
      skill: "execute",
      label: "execute",
      reason: "implementation-oriented request"
    },
    patterns: [
      { pattern: /\$?execute\b/i, score: 6 },
      { pattern: /\bimplement\b/i, score: 5 },
      { pattern: /\bfix\b/i, score: 5 },
      { pattern: /\bbuild\b/i, score: 4 },
      { pattern: /\bcode\b/i, score: 3 },
      { pattern: /구현|수정|개발/u, score: 5 },
      { pattern: /진행/u, score: 2 }
    ]
  }
];

function routeForWorkflowLabel(workflow: string | undefined): WorkflowRoute | null {
  if (!workflow) {
    return null;
  }

  return ROUTES.find((candidate) => candidate.route.label === workflow)?.route ?? null;
}

function scoreRoute(prompt: string, patterns: ScoredPattern[]): number {
  return patterns.reduce(
    (total, pattern) => total + (pattern.pattern.test(prompt) ? pattern.score : 0),
    0
  );
}

export function detectWorkflowRoute(
  prompt: string,
  previousState: SessionState | null
): WorkflowRoute | null {
  const normalized = prompt.trim();
  if (!normalized) {
    return null;
  }

  const explicitRoute = EXPLICIT_ROUTE_OVERRIDES.find((entry) => entry.pattern.test(normalized));
  if (explicitRoute) {
    return explicitRoute.route;
  }

  if (
    previousState?.workflow &&
    CONTINUATION_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    const continuedRoute = routeForWorkflowLabel(previousState.workflow);
    if (continuedRoute) {
      return {
        ...continuedRoute,
        reason: `continuation prompt preserved previous ${continuedRoute.label} workflow`
      };
    }
  }

  const scored = ROUTES
    .map((candidate) => ({
      route: candidate.route,
      score: scoreRoute(normalized, candidate.patterns)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) {
    return null;
  }

  const bestScore = scored[0].score;
  const topCandidates = scored.filter((candidate) => candidate.score === bestScore);
  if (topCandidates.length === 1) {
    return topCandidates[0].route;
  }

  if (previousState?.workflow) {
    const previousMatch = topCandidates.find(
      (candidate) => candidate.route.label === previousState.workflow
    );
    if (previousMatch) {
      return {
        ...previousMatch.route,
        reason: `ambiguous route tie resolved to previous ${previousMatch.route.label} workflow`
      };
    }
  }

  return topCandidates[0].route;
}

function routeForIntent(intent: "implementation" | "verification" | "planning" | "knowledge"): WorkflowRoute {
  switch (intent) {
    case "verification":
      return {
        skill: "verify",
        label: "verify",
        reason: "team escalation requested verification-oriented execution"
      };
    case "planning":
      return {
        skill: "plan",
        label: "plan",
        reason: "team escalation requested planning-oriented execution"
      };
    case "knowledge":
      return {
        skill: "wisdom",
        label: "wisdom",
        reason: "team escalation requested knowledge-oriented execution"
      };
    case "implementation":
    default:
      return {
        skill: "execute",
        label: "execute",
        reason: "team escalation requested implementation-oriented execution"
      };
  }
}

function buildWorkflowEnforcementContext(args: {
  route: WorkflowRoute;
  teamEscalation: AgmoTeamEscalationResult | null;
}): string[] {
  const { route, teamEscalation } = args;

  const workflowContract = (() => {
    switch (route.skill) {
      case "brainstorming":
        return [
          "Agmo runtime enforcement: brainstorming stays in the design lane (`design` remains a compatibility alias).",
          "Keep implementation blocked, gather repo context first, and delegate the primary design exploration pass to agmo-planner or another read-only support lane before proposing execution."
        ];
      case "plan":
      case "ralplan":
        return [
          route.skill === "ralplan"
            ? "Agmo runtime enforcement: ralplan is a consensus-style compatibility alias that still stays in the planning lane."
            : "Agmo runtime enforcement: planning stays in the planning lane.",
          "Delegate the primary planning pass to agmo-planner, keep the leader as orchestrator, and do not start source-code implementation from this workflow.",
          ...(route.skill === "ralplan"
            ? [
                "Raise the bar on assumptions, risks, non-goals, and verification path, and use agmo-architect/agmo-critic when the plan needs stronger boundary or challenge review."
              ]
            : [])
        ];
      case "plan-review":
        return [
          "Agmo runtime enforcement: plan-review must not self-approve the leader's own plan.",
          "Hand the critique/approval pass to agmo-verifier (optionally with agmo-planner for revisions) and keep the result as a planning-lane verdict: approve, revise, or reject."
        ];
      case "execute":
        return [
          "Agmo runtime enforcement: execute keeps the leader in orchestrator mode.",
          "Delegate the primary coding lane to agmo-executor, keep local work limited to narrow orchestration/integration/fixup steps, and pull agmo-verifier or equivalent concrete proof before claiming completion."
        ];
      case "verify":
        return [
          "Agmo runtime enforcement: verify is a proof-gathering lane, not a generic implementation lane.",
          "Delegate the evidence/test/review pass to agmo-verifier, read the actual outputs, and only hand back to execute if the verification evidence requires fixes."
        ];
      case "wisdom":
      case "vault-search":
      case "save-note":
        return [
          `Agmo runtime enforcement: ${route.skill} should be delegated away from the leader.`,
          "Use agmo-wisdom for the primary retrieval/synthesis/note-preparation lane, then bring the result back into the active workflow for integration or persistence."
        ];
      default:
        return [
          `Agmo runtime enforcement: prefer the ${route.skill} workflow contract for this turn.`,
          "Keep the leader focused on orchestration and use delegated lanes or runtime surfaces when that workflow requires them."
        ];
    }
  })();

  if (!teamEscalation) {
    return workflowContract;
  }

  if (teamEscalation.status === "started") {
    return [
      ...workflowContract,
      `Agmo runtime enforcement: the tmux team runtime \`${teamEscalation.teamName}\` is now the active worker lane.`,
      "Do not simulate replacement workers with ad-hoc in-process fanout; keep the leader on scope control, integration, monitoring, and follow-up dispatch while the live team executes."
    ];
  }

  return [
    ...workflowContract,
    `Agmo runtime enforcement: same-session team escalation was recognized but remains deferred (${teamEscalation.reason}).`,
    "Do not pretend durable tmux workers already exist; either continue with the non-team workflow contract or relaunch inside tmux before retrying the team request."
  ];
}

export async function handleUserPromptSubmit(args: {
  cwd: string;
  payload: AgmoHookPayload;
}): Promise<{ hookSpecificOutput: { hookEventName: "UserPromptSubmit"; additionalContext: string } } | null> {
  const prompt = readPromptText(args.payload);
  const previousState = await readPersistedSessionState(args);
  const teamEscalation = await escalateToSameSessionTeam({
    cwd: args.cwd,
    payload: args.payload,
    prompt,
    sessionState: previousState
  });

  const route =
    teamEscalation
      ? routeForIntent(teamEscalation.allocationIntent)
      : detectWorkflowRoute(prompt, previousState);

  if (!route) {
    return null;
  }

  if (
    previousState?.active &&
    previousState.workflow &&
    previousState.workflow !== route.label
  ) {
    try {
      await saveSessionCheckpointNote({
        cwd: args.cwd,
        trigger: "workflow_change",
        sessionState: previousState
      });
    } catch (error) {
      void error;
    }
  }

  const persisted = await writeWorkflowActivation({
    cwd: args.cwd,
    payload: args.payload,
    workflow: route.label,
    reason: route.reason
  });

  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: [
        `Agmo native UserPromptSubmit routed this prompt to ${route.skill} (${route.reason}). Prefer that skill surface for this turn. Durable workflow state was written to .agmo/state/workflows/${persisted.workflowStatePathStem}.json for session ${persisted.sessionId}.`,
        ...buildWorkflowEnforcementContext({
          route,
          teamEscalation
        }),
        ...(
          teamEscalation
            ? teamEscalation.status === "started"
              ? [
                  `Agmo same-session $team escalation launched tmux team runtime \`${teamEscalation.teamName}\` with ${teamEscalation.workerCount} workers (${teamEscalation.allocationIntent}); worker panes created=${teamEscalation.tmuxWorkerPaneCount}; hud=${teamEscalation.hudEnabled ? "on" : "off"}; leader pane=${teamEscalation.leaderPaneId ?? "unknown"}. Handoff artifact: ${teamEscalation.handoffPathRelative}. Continue in leader/orchestrator mode and treat the team as already running.`
                ]
              : [
                  `Agmo recognized a same-session team escalation request but did not auto-launch the team because ${teamEscalation.reason}. Handoff artifact: ${teamEscalation.handoffPathRelative}. If the user wants pane-based team UX, relaunch the leader inside tmux and retry the same request.`
                ]
            : []
        )
      ].join(" ")
    }
  };
}
