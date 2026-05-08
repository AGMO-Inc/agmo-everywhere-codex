import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionState } from "../hooks/runtime-state.js";
import {
  saveSessionCheckpointNote,
  saveWorkflowArtifactNote
} from "./checkpoint.js";

async function withVaultRoot<T>(vaultRoot: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.AGMO_VAULT_ROOT;
  const previousProjectRoot = process.env.AGMO_PROJECT_ROOT;
  process.env.AGMO_VAULT_ROOT = vaultRoot;
  process.env.AGMO_PROJECT_ROOT = vaultRoot;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.AGMO_VAULT_ROOT;
    } else {
      process.env.AGMO_VAULT_ROOT = previous;
    }
    if (previousProjectRoot === undefined) {
      delete process.env.AGMO_PROJECT_ROOT;
    } else {
      process.env.AGMO_PROJECT_ROOT = previousProjectRoot;
    }
  }
}

function buildSessionState(overrides: Partial<SessionState>): SessionState {
  return {
    version: 1,
    session_id: "session-12345678",
    active: true,
    last_event: "Stop",
    workflow: "vault-search",
    workflow_reason: "knowledge retrieval request",
    prompt_excerpt:
      "[Memo] Agmo remaining implementation items] <- 옵시디언 내용 읽고 구현 시작하자.",
    updated_at: "2026-04-23T10:00:00.000Z",
    started_at: "2026-04-23T09:55:00.000Z",
    completed_at: "2026-04-23T10:00:00.000Z",
    ...overrides
  };
}

async function listMarkdownFiles(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).filter((entry) => entry.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

test("saveSessionCheckpointNote derives cleaner autosave titles and richer search tags", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-checkpoint-"));
  const project = "demo-project";
  const projectRoot = join(tempRoot, project);
  await mkdir(projectRoot, { recursive: true });

  await withVaultRoot(projectRoot, async () => {
    const result = await saveSessionCheckpointNote({
      cwd: projectRoot,
      trigger: "stop",
      sessionState: buildSessionState({})
    });

    assert.ok(result);
    assert.equal(result.project_wikilink, "[[demo-project]]");
    assert.match(
      result.title,
      /^\d{4}-\d{2}-\d{2} Agmo remaining implementation items$/
    );
    assert.doesNotMatch(result.title, /\[Memo\]|읽고 구현 시작하자|12345678/);

    const note = await readFile(result.path, "utf8");
    assert.match(note, /aliases:\n  - "2026-04-23 Agmo remaining implementation items"/);
    assert.match(note, /  - "Agmo remaining implementation items"/);
    assert.match(note, /  - "project\/demo-project"/);
    assert.match(note, /  - "workflow\/vault-search"/);
    assert.match(note, /project_note: "\[\[demo-project\]\]"/);
  });
});

test("saveSessionCheckpointNote falls back from worker bootstrap prompts to stable checkpoint titles", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-checkpoint-worker-"));
  const project = "demo-project";
  const projectRoot = join(tempRoot, project);
  await mkdir(projectRoot, { recursive: true });

  await withVaultRoot(projectRoot, async () => {
    const result = await saveSessionCheckpointNote({
      cwd: projectRoot,
      trigger: "post_tool_use_success",
      sessionState: buildSessionState({
        workflow: "execute",
        workflow_reason: "team escalation requested implementation-oriented execution",
        last_event: "PostToolUse",
        prompt_excerpt:
          "You are worker-2 for team 1-2-3-ce6e6eec. Read the inbox file at /tmp/inbox.md first. Current task summary: 1,2,3 병렬 진행."
      })
    });

    assert.ok(result);
    assert.equal(result.title, "2026-04-23 Agmo execute checkpoint");

    const note = await readFile(result.path, "utf8");
    assert.doesNotMatch(note, /You are worker-2/);
    assert.match(note, /aliases:\n  - "2026-04-23 Agmo execute checkpoint"/);
    assert.match(note, /  - "Agmo execute checkpoint"/);
  });
});

test("design and research autosaves render focused briefs instead of raw prompt dumps", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-checkpoint-briefs-"));
  const project = "demo-project";
  const projectRoot = join(tempRoot, project);
  await mkdir(projectRoot, { recursive: true });

  await withVaultRoot(projectRoot, async () => {
    const design = await saveSessionCheckpointNote({
      cwd: projectRoot,
      trigger: "stop",
      sessionState: buildSessionState({
        workflow: "brainstorming",
        workflow_reason: "compare brainstorming and deep-interview flows",
        prompt_excerpt:
          "브레인스토밍은 현재 Agmo 워크플로우와 기존 디자인 노트를 비교해서 설계하자.",
        last_event: "Stop"
      })
    });

    assert.ok(design);
    const designNote = await readFile(design.path, "utf8");
    assert.match(designNote, /## Design Brief/);
    assert.match(designNote, /## Decision Drivers/);
    assert.match(designNote, /## Recommended Next Step/);
    assert.match(designNote, /> 브레인스토밍은 현재 Agmo 워크플로우와 기존 디자인 노트를 비교해서 설계하자\./);
    assert.doesNotMatch(designNote, /## 개요/);

    const research = await saveSessionCheckpointNote({
      cwd: projectRoot,
      trigger: "stop",
      sessionState: buildSessionState({
        workflow: "vault-search",
        workflow_reason: "recover prior vault decisions before implementation",
        prompt_excerpt: "[Memo] Agmo remaining implementation items] <- 옵시디언 내용 읽고 구현 시작하자.",
        last_event: "PostToolUse",
        last_tool_name: "Search",
        last_tool_status: "succeeded",
        last_tool_summary: "Found related implementation and memo notes"
      })
    });

    assert.ok(research);
    const researchNote = await readFile(research.path, "utf8");
    assert.match(researchNote, /## Research Brief/);
    assert.match(researchNote, /## Findings Snapshot/);
    assert.match(researchNote, /Found related implementation and memo notes/);
    assert.match(researchNote, /## Recommended Follow-up/);
    assert.doesNotMatch(researchNote, /## 배경/);
    assert.doesNotMatch(researchNote, /## 조사 내용/);
  });
});

test("saveSessionCheckpointNote respects per-workflow autosave disable config", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-checkpoint-workflow-toggle-"));
  const project = "demo-project";
  const projectRoot = join(tempRoot, project);
  await mkdir(join(projectRoot, ".agmo"), { recursive: true });
  await writeFile(
    join(projectRoot, ".agmo", "config.json"),
    `${JSON.stringify(
      {
        vault_autosave: {
          workflow_enabled: {
            verify: false
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await withVaultRoot(projectRoot, async () => {
    const skipped = await saveSessionCheckpointNote({
      cwd: projectRoot,
      trigger: "stop",
      sessionState: buildSessionState({
        workflow: "verify",
        workflow_reason: "verification evidence review",
        prompt_excerpt: "검증 로그를 점검하고 요약하자."
      })
    });

    assert.equal(skipped, null);
    assert.deepEqual(await listMarkdownFiles(join(projectRoot, "memos")), []);

    const preserved = await saveSessionCheckpointNote({
      cwd: projectRoot,
      trigger: "stop",
      sessionState: buildSessionState({
        workflow: "execute",
        workflow_reason: "implementation in progress",
        prompt_excerpt: "구현 체크포인트는 계속 저장하자."
      })
    });

    assert.ok(preserved);
    assert.match(preserved.relative_path, /implementations\//);
    assert.deepEqual(await listMarkdownFiles(join(projectRoot, "memos")), []);
  });
});

test("saveWorkflowArtifactNote writes stage-end artifacts separate from checkpoint memos", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-artifact-stage-end-"));
  const project = "demo-project";
  const projectRoot = join(tempRoot, project);
  await mkdir(projectRoot, { recursive: true });

  await withVaultRoot(projectRoot, async () => {
    const plan = await saveWorkflowArtifactNote({
      cwd: projectRoot,
      trigger: "workflow_change",
      sessionState: buildSessionState({
        workflow: "plan",
        workflow_reason: "planning/decomposition-oriented request",
        prompt_excerpt: "Vault autosave 품질 개선 실행 계획을 정리하자.",
        last_event: "PostToolUse",
        last_tool_name: "Bash",
        last_tool_status: "succeeded",
        last_tool_summary: "Inspected checkpoint renderer and legacy archivist flow"
      })
    });

    assert.ok(plan);
    assert.match(plan.relative_path, /plans\/\[Plan\] /);
    assert.doesNotMatch(plan.relative_path, /memos\//);
    const note = await readFile(plan.path, "utf8");
    assert.match(note, /schema: "agmo-artifact-plan-v1"/);
    assert.match(note, /artifact_kind: "plan"/);
    assert.match(note, /## Plan Record/);
    assert.match(note, /## Execution Handoff/);
    assert.match(note, /## Source Request/);
    assert.match(note, /Inspected checkpoint renderer and legacy archivist flow/);
    assert.doesNotMatch(note, /Auto-saved by Agmo native/);
    assert.match(note, /  - "artifact"/);
  });
});

test("saveWorkflowArtifactNote links implementation artifacts to prior plan artifacts", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-artifact-links-"));
  const project = "demo-project";
  const projectRoot = join(tempRoot, project);
  await mkdir(projectRoot, { recursive: true });

  await withVaultRoot(projectRoot, async () => {
    const plan = await saveWorkflowArtifactNote({
      cwd: projectRoot,
      trigger: "workflow_change",
      sessionState: buildSessionState({
        workflow: "plan",
        workflow_reason: "execution-ready planning",
        prompt_excerpt: "Artifact save gate 계획을 수립하자."
      })
    });

    assert.ok(plan);

    const impl = await saveWorkflowArtifactNote({
      cwd: projectRoot,
      trigger: "stop",
      sessionState: buildSessionState({
        workflow: "execute",
        workflow_reason: "implementation-oriented request",
        prompt_excerpt: "Artifact save gate 구현을 완료하자.",
        artifact_notes: {
          plan: {
            workflow: "plan",
            type: plan.type,
            title: plan.title,
            relative_path: plan.relative_path,
            wikilink: plan.wikilink,
            saved_at: "2026-04-23T10:00:00.000Z"
          }
        },
        verification_history: [
          {
            tool_name: "test",
            tool_status: "succeeded",
            tool_summary: "artifact tests passed",
            recorded_at: "2026-04-23T10:00:00.000Z"
          }
        ]
      })
    });

    assert.ok(impl);
    assert.match(impl.relative_path, /implementations\/\[Impl\] /);
    const note = await readFile(impl.path, "utf8");
    assert.match(note, new RegExp(`parent: ${JSON.stringify(plan.wikilink).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(note, /## Implementation Record/);
    assert.match(note, /artifact tests passed/);

    const planNote = await readFile(plan.path, "utf8");
    assert.match(planNote, /## Implementations/);
    assert.match(planNote, new RegExp(impl.wikilink.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});
