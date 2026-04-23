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
