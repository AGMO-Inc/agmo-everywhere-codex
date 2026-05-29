import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPersistedSessionState } from "./runtime-state.js";
import type { SessionState } from "./runtime-state.js";
import { detectWorkflowRoute, handleUserPromptSubmit } from "./user-prompt-submit.js";
import { metadataForWorkflowRoute } from "./workflow-route-metadata.js";

function previousWorkflow(workflow: string): SessionState {
  return {
    version: 1,
    session_id: `previous-${workflow}`,
    active: true,
    last_event: "UserPromptSubmit",
    workflow,
    updated_at: new Date(0).toISOString()
  };
}

type GoldenRouteCase = {
  name: string;
  prompt: string;
  previousState?: SessionState | null;
  expected: {
    skill: string;
    label: string;
    source: NonNullable<ReturnType<typeof detectWorkflowRoute>>["source"];
    confidence: NonNullable<ReturnType<typeof detectWorkflowRoute>>["confidence"];
    fallback?: string;
    score?: number;
    alternatives?: string[];
  };
};

const GOLDEN_ROUTE_MATRIX: GoldenRouteCase[] = [
  {
    name: "explicit English plan",
    prompt: "$plan break down the release checklist",
    expected: {
      skill: "plan",
      label: "plan",
      source: "explicit",
      confidence: "high"
    }
  },
  {
    name: "explicit design alias routes to brainstorming",
    prompt: "$design explore product direction",
    expected: {
      skill: "brainstorming",
      label: "brainstorming",
      source: "explicit",
      confidence: "high"
    }
  },
  {
    name: "Korean prior note retrieval",
    prompt: "이전 설계 노트 찾아서 읽어줘",
    expected: {
      skill: "vault-search",
      label: "vault-search",
      source: "pattern",
      confidence: "high",
      score: 9,
      alternatives: ["brainstorming"]
    }
  },
  {
    name: "Korean git workflow",
    prompt: "커밋하고 푸시해줘",
    expected: {
      skill: "git-workflow",
      label: "git-workflow",
      source: "pattern",
      confidence: "medium",
      score: 6
    }
  },
  {
    name: "Korean note to issue conversion",
    prompt: "이 옵시디언 노트를 깃허브 이슈로 변환해줘",
    expected: {
      skill: "note-to-issue",
      label: "note-to-issue",
      source: "pattern",
      confidence: "high",
      score: 8
    }
  },
  {
    name: "completion-gated Korean execution",
    prompt: "검증 통과할 때까지 구현해줘",
    expected: {
      skill: "ralph",
      label: "execute",
      source: "pattern",
      confidence: "medium",
      score: 6,
      alternatives: ["execute", "verify"]
    }
  },
  {
    name: "English implementation",
    prompt: "implement the accepted fix",
    expected: {
      skill: "execute",
      label: "execute",
      source: "pattern",
      confidence: "high",
      score: 10
    }
  },
  {
    name: "English verification review",
    prompt: "review the implementation and test coverage",
    expected: {
      skill: "verify",
      label: "verify",
      source: "pattern",
      confidence: "high",
      score: 8
    }
  },
  {
    name: "Korean consensus planning",
    prompt: "합의형 계획으로 정리해줘",
    expected: {
      skill: "ralplan",
      label: "plan",
      source: "pattern",
      confidence: "medium",
      score: 6,
      alternatives: ["wisdom", "plan"]
    }
  },
  {
    name: "continuation preserves execute",
    prompt: "continue",
    previousState: previousWorkflow("execute"),
    expected: {
      skill: "execute",
      label: "execute",
      source: "continuation",
      confidence: "high",
      fallback: "execute"
    }
  },
  {
    name: "ambiguous tie preserves previous workflow",
    prompt: "docs code",
    previousState: previousWorkflow("wisdom"),
    expected: {
      skill: "wisdom",
      label: "wisdom",
      source: "ambiguous-tie",
      confidence: "low",
      fallback: "wisdom",
      score: 3,
      alternatives: ["execute"]
    }
  },
  {
    name: "ambiguous tie without previous workflow keeps stable route order",
    prompt: "docs code",
    expected: {
      skill: "wisdom",
      label: "wisdom",
      source: "ambiguous-tie",
      confidence: "low",
      score: 3,
      alternatives: ["execute"]
    }
  }
];

test("detectWorkflowRoute matches the golden routing matrix", () => {
  for (const routeCase of GOLDEN_ROUTE_MATRIX) {
    const route = detectWorkflowRoute(routeCase.prompt, routeCase.previousState ?? null);
    assert.ok(route, `${routeCase.name} should route`);
    assert.equal(route.skill, routeCase.expected.skill, routeCase.name);
    assert.equal(route.label, routeCase.expected.label, routeCase.name);
    assert.equal(route.source, routeCase.expected.source, routeCase.name);
    assert.equal(route.confidence, routeCase.expected.confidence, routeCase.name);
    assert.equal(route.fallback, routeCase.expected.fallback, routeCase.name);
    assert.equal(route.score, routeCase.expected.score, routeCase.name);
    assert.deepEqual(
      route.alternatives?.map((alternative) => alternative.skill),
      routeCase.expected.alternatives,
      routeCase.name
    );
    assert.deepEqual(
      {
        operational_category: route.operational_category,
        recommended_agent: route.recommended_agent,
        recommended_effort: route.recommended_effort,
        verification_strategy: route.verification_strategy
      },
      metadataForWorkflowRoute(route),
      `${routeCase.name} should include operational metadata`
    );
  }
});

test("metadataForWorkflowRoute categorizes workflows without changing selected routes", () => {
  assert.deepEqual(metadataForWorkflowRoute({ skill: "execute", label: "execute" }), {
    operational_category: "implementation",
    recommended_agent: "agmo-executor",
    recommended_effort: "medium",
    verification_strategy: "run targeted tests plus typecheck/build evidence before claiming completion"
  });

  assert.deepEqual(metadataForWorkflowRoute({ skill: "verify", label: "verify" }), {
    operational_category: "verification",
    recommended_agent: "agmo-verifier",
    recommended_effort: "medium",
    verification_strategy: "distinguish failed behavior from missing proof with concrete command or diff evidence"
  });

  assert.deepEqual(metadataForWorkflowRoute({ skill: "plan-review", label: "plan" }), {
    operational_category: "planning",
    recommended_agent: "agmo-critic",
    recommended_effort: "high",
    verification_strategy: "produce an approve, revise, or reject verdict grounded in plan evidence"
  });
});

test("detectWorkflowRoute marks explicit routes as high confidence", () => {
  const route = detectWorkflowRoute("$execute implement the accepted fix", null);
  assert.ok(route);
  assert.equal(route.skill, "execute");
  assert.equal(route.source, "explicit");
  assert.equal(route.confidence, "high");
});

test("detectWorkflowRoute prefers vault-search for prior note retrieval asks", () => {
  const route = detectWorkflowRoute("이전 설계 노트 찾아서 읽어줘", null);
  assert.ok(route);
  assert.equal(route?.skill, "vault-search");
});

test("detectWorkflowRoute prefers save-note for checkpoint persistence asks", () => {
  const route = detectWorkflowRoute("이 결정사항 체크포인트로 저장해줘", null);
  assert.ok(route);
  assert.equal(route?.skill, "save-note");
});

test("detectWorkflowRoute keeps wisdom for synthesis-oriented doc asks", () => {
  const route = detectWorkflowRoute("wisdom 스킬 관련 문서들 비교 정리해줘", null);
  assert.ok(route);
  assert.equal(route?.skill, "wisdom");
});

test("detectWorkflowRoute prefers git-workflow for commit requests", () => {
  const route = detectWorkflowRoute("커밋하고 푸시해줘", null);
  assert.ok(route);
  assert.equal(route?.skill, "git-workflow");
});

test("detectWorkflowRoute prefers create-issue for conversation-based issue creation", () => {
  const route = detectWorkflowRoute("이 내용으로 깃허브 이슈 만들어줘", null);
  assert.ok(route);
  assert.equal(route?.skill, "create-issue");
});

test("detectWorkflowRoute prefers note-to-issue over generic issue creation for note conversions", () => {
  const route = detectWorkflowRoute("이 옵시디언 노트를 깃허브 이슈로 변환해줘", null);
  assert.ok(route);
  assert.equal(route?.skill, "note-to-issue");
});


test("detectWorkflowRoute routes explicit $ralplan to the planning lane alias", () => {
  const route = detectWorkflowRoute("$ralplan 인증 흐름 개편 계획 짜줘", null);
  assert.ok(route);
  assert.equal(route?.skill, "ralplan");
  assert.equal(route?.label, "plan");
});

test("detectWorkflowRoute prefers ralplan for consensus-style planning asks", () => {
  const route = detectWorkflowRoute("합의형 계획으로 정리해줘", null);
  assert.ok(route);
  assert.equal(route?.skill, "ralplan");
  assert.equal(route?.label, "plan");
});


test("detectWorkflowRoute routes explicit $ralph to completion-gated execute", () => {
  const route = detectWorkflowRoute("$ralph 결제 에러 수정 끝까지 진행해줘", null);
  assert.ok(route);
  assert.equal(route?.skill, "ralph");
  assert.equal(route?.label, "execute");
});

test("detectWorkflowRoute prefers ralph for completion-gated execution asks", () => {
  const route = detectWorkflowRoute("검증 통과할 때까지 구현해줘", null);
  assert.ok(route);
  assert.equal(route?.skill, "ralph");
  assert.equal(route?.label, "execute");
});

test("detectWorkflowRoute keeps canonical plan on continuation prompts", () => {
  const route = detectWorkflowRoute("continue", {
    version: 1,
    session_id: "s1",
    active: true,
    last_event: "UserPromptSubmit",
    workflow: "plan",
    updated_at: new Date(0).toISOString()
  });
  assert.ok(route);
  assert.equal(route?.skill, "plan");
  assert.equal(route?.label, "plan");
  assert.equal(route?.source, "continuation");
  assert.equal(route?.confidence, "high");
  assert.equal(route?.fallback, "plan");
});

test("detectWorkflowRoute keeps canonical execute on continuation prompts", () => {
  const route = detectWorkflowRoute("continue", {
    version: 1,
    session_id: "s2",
    active: true,
    last_event: "UserPromptSubmit",
    workflow: "execute",
    updated_at: new Date(0).toISOString()
  });
  assert.ok(route);
  assert.equal(route?.skill, "execute");
  assert.equal(route?.label, "execute");
});

test("detectWorkflowRoute preserves previous workflow on ambiguous ties with alternatives", () => {
  const route = detectWorkflowRoute("docs code", {
    version: 1,
    session_id: "s3",
    active: true,
    last_event: "UserPromptSubmit",
    workflow: "wisdom",
    updated_at: new Date(0).toISOString()
  });

  assert.ok(route);
  assert.equal(route.skill, "wisdom");
  assert.equal(route.label, "wisdom");
  assert.equal(route.source, "ambiguous-tie");
  assert.equal(route.confidence, "low");
  assert.equal(route.score, 3);
  assert.equal(route.fallback, "wisdom");
  assert.deepEqual(
    route.alternatives?.map((alternative) => alternative.skill),
    ["execute"]
  );
});

test("handleUserPromptSubmit injects native subagent cleanup guidance for delegated workflows", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-user-prompt-subagent-cleanup-"));
  const result = await handleUserPromptSubmit({
    cwd: tempRoot,
    payload: {
      session_id: "subagent-cleanup-session",
      prompt: "$execute implement the accepted fix"
    }
  });

  assert.ok(result);
  const context = result.hookSpecificOutput.additionalContext;
  assert.match(context, /Agmo native subagent lifecycle:/);
  assert.match(context, /call `close_agent`/);
  assert.match(context, /release thread slots/);
});

test("handleUserPromptSubmit injects workflow artifact guidance for delegated workflows", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-user-prompt-artifact-"));
  const result = await handleUserPromptSubmit({
    cwd: tempRoot,
    payload: {
      session_id: "artifact-guidance-session",
      prompt: "$plan design the durable vault save flow",
    },
  });

  assert.ok(result);
  const context = result.hookSpecificOutput.additionalContext;
  assert.match(context, /Agmo workflow artifact contract:/);
  assert.match(context, /artifact-grade summary/);
  assert.match(context, /rather than relying only on terse hook checkpoints/);
});

test("handleUserPromptSubmit keeps plan-review metadata aligned with enforcement guidance", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-user-prompt-plan-review-"));
  const result = await handleUserPromptSubmit({
    cwd: tempRoot,
    payload: {
      session_id: "plan-review-context-session",
      prompt: "$plan-review challenge the implementation plan"
    }
  });

  assert.ok(result);
  const context = result.hookSpecificOutput.additionalContext;
  assert.match(context, /IntentGate evidence: .*skill=plan-review .*agent=agmo-critic/);
  assert.match(context, /Hand the critique\/approval pass to agmo-critic/);
  assert.doesNotMatch(context, /Hand the critique\/approval pass to agmo-verifier/);
});

test("handleUserPromptSubmit persists route metadata and emits compact IntentGate evidence", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-user-prompt-route-metadata-"));
  const payload = {
    session_id: "route-metadata-session",
    prompt: "$execute implement the accepted fix"
  };
  const result = await handleUserPromptSubmit({
    cwd: tempRoot,
    payload
  });

  assert.ok(result);
  const context = result.hookSpecificOutput.additionalContext;
  assert.match(
    context,
    /IntentGate evidence: skill=execute label=execute source=explicit confidence=high reason=explicit \$execute invocation category=implementation agent=agmo-executor effort=medium\./
  );

  const state = await readPersistedSessionState({
    cwd: tempRoot,
    payload
  });

  assert.ok(state);
  assert.equal(state.workflow, "execute");
  assert.equal(state.workflow_reason, "explicit $execute invocation");
  assert.deepEqual(state.workflow_route, {
    skill: "execute",
    label: "execute",
    reason: "explicit $execute invocation",
    source: "explicit",
    confidence: "high",
    operational_category: "implementation",
    recommended_agent: "agmo-executor",
    recommended_effort: "medium",
    verification_strategy: "run targeted tests plus typecheck/build evidence before claiming completion"
  });
});
