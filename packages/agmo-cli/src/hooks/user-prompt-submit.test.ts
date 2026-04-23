import assert from "node:assert/strict";
import test from "node:test";
import { detectWorkflowRoute } from "./user-prompt-submit.js";

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
