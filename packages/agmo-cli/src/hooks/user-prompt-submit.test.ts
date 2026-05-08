import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectWorkflowRoute, handleUserPromptSubmit } from "./user-prompt-submit.js";

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
