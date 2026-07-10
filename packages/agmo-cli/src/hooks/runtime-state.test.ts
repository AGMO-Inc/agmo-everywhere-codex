import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isSessionState,
  isWorkflowStateRef,
  markSessionStopped,
  readPersistedSessionState,
  recordSessionActivity,
  recordSessionArtifact,
  recordSessionAutosave,
  recordSessionWisdomPersistence,
  safeFileStem,
  writeWorkflowActivation,
  type AgmoHookPayload,
  type SessionState,
  type SessionWorkflowNoteRef,
  type WorkflowRouteRecord,
  type WorkflowStateRef
} from "./runtime-state.js";
import { resolveInstallPaths } from "../utils/paths.js";

function stateFixture(sessionId: string, overrides: Partial<SessionState> = {}): SessionState {
  return {
    version: 1,
    session_id: sessionId,
    active: true,
    last_event: "UserPromptSubmit",
    workflow: "execute",
    workflow_reason: "fixture",
    updated_at: "2026-01-01T00:00:00.000Z",
    started_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function compactFixture(
  sessionId: string,
  overrides: Partial<WorkflowStateRef> = {}
): WorkflowStateRef {
  return {
    version: 1,
    kind: "workflow_state_ref",
    session_id: sessionId,
    session_state_ref: `../sessions/${safeFileStem(sessionId)}.json`,
    active: true,
    status: "active",
    last_event: "UserPromptSubmit",
    workflow: "execute",
    updated_at: "2026-01-01T00:00:00.000Z",
    started_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeSession(root: string, sessionId: string, state: SessionState): Promise<void> {
  const { sessionsStateDir } = resolveInstallPaths("project", root);
  await writeJson(join(sessionsStateDir, `${safeFileStem(sessionId)}.json`), state);
}

async function writeWorkflow(
  root: string,
  sessionId: string,
  state: SessionState | WorkflowStateRef
): Promise<void> {
  const { workflowsStateDir } = resolveInstallPaths("project", root);
  await writeJson(join(workflowsStateDir, `${safeFileStem(sessionId)}.json`), state);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

async function readState(root: string, sessionId: string): Promise<SessionState | null> {
  return await readPersistedSessionState({ cwd: root, payload: { session_id: sessionId } });
}

test("runtime-state type guards distinguish full session states from compact workflow refs", () => {
  const session = stateFixture("guard-session");
  const compact = compactFixture("guard-session");

  assert.equal(isSessionState(session), true);
  assert.equal(isWorkflowStateRef(session), false);
  assert.equal(isSessionState(compact), false);
  assert.equal(isWorkflowStateRef(compact), true);
  assert.equal(isSessionState({ ...session, active: "true" }), false);
  assert.equal(isWorkflowStateRef({ ...compact, status: "running" }), false);
});

test("readPersistedSessionState supports session-only, session-plus-index, compact-plus-session, compact-only, and legacy workflow-only states", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "agmo-runtime-state-read-"));
  const sessionOnly = stateFixture("session-only", { workflow: "session-only" });
  await writeSession(root, "session-only", sessionOnly);
  assert.equal((await readState(root, "session-only"))?.workflow, "session-only");

  const sessionPlusIndex = stateFixture("session-plus-index", { workflow: "canonical" });
  await writeSession(root, "session-plus-index", sessionPlusIndex);
  await writeWorkflow(
    root,
    "session-plus-index",
    compactFixture("session-plus-index", { workflow: "compact" })
  );
  assert.equal((await readState(root, "session-plus-index"))?.workflow, "canonical");

  const compactPlusSession = stateFixture("compact-plus-session", { workflow: "sibling" });
  await writeWorkflow(root, "compact-plus-session", compactFixture("compact-plus-session"));
  await writeSession(root, "compact-plus-session", compactPlusSession);
  assert.equal((await readState(root, "compact-plus-session"))?.workflow, "sibling");

  await writeWorkflow(root, "compact-only", compactFixture("compact-only"));
  assert.equal(await readState(root, "compact-only"), null);

  const legacyWorkflow = stateFixture("legacy-workflow-only", { workflow: "legacy" });
  await writeWorkflow(root, "legacy-workflow-only", legacyWorkflow);
  assert.equal((await readState(root, "legacy-workflow-only"))?.workflow, "legacy");
});

test("readPersistedSessionState never follows tampered compact session_state_ref", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "agmo-runtime-state-tamper-"));
  const outsideSession = stateFixture("outside", { workflow: "outside-file" });
  await writeSession(root, "outside", outsideSession);
  await writeWorkflow(
    root,
    "victim",
    compactFixture("victim", {
      session_state_ref: `../sessions/${safeFileStem("outside")}.json`
    })
  );

  assert.equal(await readState(root, "victim"), null);
});

test("readPersistedSessionState chooses the newer valid legacy full state and session on ties or invalid timestamps", async () => {
  const cases: Array<{
    name: string;
    sessionUpdatedAt: string;
    workflowUpdatedAt: string;
    expectedWorkflow: string;
  }> = [
    {
      name: "workflow-newer",
      sessionUpdatedAt: "2026-01-01T00:00:00.000Z",
      workflowUpdatedAt: "2026-01-02T00:00:00.000Z",
      expectedWorkflow: "workflow"
    },
    {
      name: "session-newer",
      sessionUpdatedAt: "2026-01-03T00:00:00.000Z",
      workflowUpdatedAt: "2026-01-02T00:00:00.000Z",
      expectedWorkflow: "session"
    },
    {
      name: "workflow-only-valid",
      sessionUpdatedAt: "not-a-date",
      workflowUpdatedAt: "2026-01-02T00:00:00.000Z",
      expectedWorkflow: "workflow"
    },
    {
      name: "session-only-valid",
      sessionUpdatedAt: "2026-01-02T00:00:00.000Z",
      workflowUpdatedAt: "not-a-date",
      expectedWorkflow: "session"
    },
    {
      name: "tie",
      sessionUpdatedAt: "2026-01-02T00:00:00.000Z",
      workflowUpdatedAt: "2026-01-02T00:00:00.000Z",
      expectedWorkflow: "session"
    },
    {
      name: "both-invalid",
      sessionUpdatedAt: "nope",
      workflowUpdatedAt: "also-nope",
      expectedWorkflow: "session"
    }
  ];

  for (const item of cases) {
    const root = await mkdtemp(join(os.tmpdir(), `agmo-runtime-state-${item.name}-`));
    const sessionId = `freshness-${item.name}`;
    await writeSession(
      root,
      sessionId,
      stateFixture(sessionId, {
        workflow: "session",
        updated_at: item.sessionUpdatedAt
      })
    );
    await writeWorkflow(
      root,
      sessionId,
      stateFixture(sessionId, {
        workflow: "workflow",
        updated_at: item.workflowUpdatedAt
      })
    );

    assert.equal((await readState(root, sessionId))?.workflow, item.expectedWorkflow, item.name);
  }
});

test("a newer canonical session beats a stale legacy workflow after index write failure", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "agmo-runtime-state-stale-workflow-"));
  const sessionId = "stale-after-failure";
  await writeSession(
    root,
    sessionId,
    stateFixture(sessionId, {
      workflow: "new-session",
      updated_at: "2026-01-03T00:00:00.000Z"
    })
  );
  await writeWorkflow(
    root,
    sessionId,
    stateFixture(sessionId, {
      workflow: "old-workflow",
      updated_at: "2026-01-01T00:00:00.000Z"
    })
  );

  assert.equal((await readState(root, sessionId))?.workflow, "new-session");
});

test("session write failure rejects before creating a workflow index", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "agmo-runtime-state-session-fail-"));
  const { sessionsStateDir, workflowsStateDir } = resolveInstallPaths("project", root);
  await mkdir(join(root, ".agmo", "state"), { recursive: true });
  await writeFile(sessionsStateDir, "not a directory", "utf8");

  await assert.rejects(
    writeWorkflowActivation({
      cwd: root,
      payload: { session_id: "write-fails" },
      workflow: "execute",
      reason: "test"
    })
  );
  assert.equal(existsSync(join(workflowsStateDir, "write-fails.json")), false);
});

test("workflow index write failure rejects while canonical session remains durable and readable", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "agmo-runtime-state-index-fail-"));
  const { sessionsStateDir, workflowsStateDir } = resolveInstallPaths("project", root);
  await mkdir(sessionsStateDir, { recursive: true });
  await mkdir(join(root, ".agmo", "state"), { recursive: true });
  await writeFile(workflowsStateDir, "not a directory", "utf8");

  await assert.rejects(
    writeWorkflowActivation({
      cwd: root,
      payload: { session_id: "index-fails" },
      workflow: "execute",
      reason: "test"
    })
  );

  assert.equal(existsSync(join(sessionsStateDir, "index-fails.json")), true);
  assert.equal((await readState(root, "index-fails"))?.workflow, "execute");
});

test("all runtime-state writer APIs persist a full session and compact workflow index", async () => {
  const writers: Array<{
    name: string;
    sessionId: string;
    run: (root: string, payload: AgmoHookPayload) => Promise<unknown>;
  }> = [
    {
      name: "writeWorkflowActivation",
      sessionId: "writer-activation",
      run: async (root, payload) =>
        await writeWorkflowActivation({ cwd: root, payload, workflow: "execute", reason: "test" })
    },
    {
      name: "markSessionStopped",
      sessionId: "writer-stop",
      run: async (root, payload) => await markSessionStopped({ cwd: root, payload })
    },
    {
      name: "recordSessionActivity",
      sessionId: "writer-activity",
      run: async (root, payload) =>
        await recordSessionActivity({
          cwd: root,
          payload,
          lastEvent: "PostToolUse",
          toolName: "node",
          toolSummary: "ok",
          toolStatus: "succeeded"
        })
    },
    {
      name: "recordSessionAutosave",
      sessionId: "writer-autosave",
      run: async (root, payload) =>
        await recordSessionAutosave({
          cwd: root,
          payload,
          autosaveAt: "2026-01-01T00:00:00.000Z",
          autosaveTrigger: "stop",
          autosaveSignature: "sig"
        })
    },
    {
      name: "recordSessionArtifact",
      sessionId: "writer-artifact",
      run: async (root, payload) =>
        await recordSessionArtifact({
          cwd: root,
          payload,
          artifactAt: "2026-01-01T00:00:00.000Z",
          workflow: "execute",
          noteRef: noteRef("execute")
        })
    },
    {
      name: "recordSessionWisdomPersistence",
      sessionId: "writer-wisdom",
      run: async (root, payload) =>
        await recordSessionWisdomPersistence({
          cwd: root,
          payload,
          savedAt: "2026-01-01T00:00:00.000Z",
          signature: "wisdom-sig"
        })
    }
  ];

  for (const writer of writers) {
    const root = await mkdtemp(join(os.tmpdir(), `agmo-runtime-state-${writer.name}-`));
    const { sessionsStateDir, workflowsStateDir } = resolveInstallPaths("project", root);
    await writer.run(root, { session_id: writer.sessionId });
    const sessionRecord = readJson(join(sessionsStateDir, `${writer.sessionId}.json`));
    const workflowRecord = readJson(join(workflowsStateDir, `${writer.sessionId}.json`));

    assert.equal(isSessionState(sessionRecord), true, writer.name);
    assert.equal(isWorkflowStateRef(workflowRecord), true, writer.name);
    assert.equal(workflowRecord.session_state_ref, `../sessions/${writer.sessionId}.json`);
  }
});

test("subsequent writes merge from full canonical state and preserve full-only fields", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "agmo-runtime-state-merge-"));
  const sessionId = "merge-session";
  const route: WorkflowRouteRecord = {
    skill: "execute",
    label: "execute",
    reason: "test route",
    source: "pattern",
    confidence: "high"
  };
  await writeSession(
    root,
    sessionId,
    stateFixture(sessionId, {
      workflow_route: route,
      last_tool_name: "pnpm",
      last_tool_summary: "previous summary",
      last_tool_status: "succeeded",
      last_wisdom_entry_signature: "wisdom",
      last_wisdom_entry_saved_at: "2026-01-01T00:00:00.000Z",
      autosave_notes: { execute: noteRef("execute") },
      artifact_notes: { verify: noteRef("verify") },
      verification_history: [
        {
          tool_name: "pnpm",
          tool_status: "succeeded",
          tool_summary: "previous",
          recorded_at: "2026-01-01T00:00:00.000Z"
        }
      ]
    })
  );
  await writeWorkflow(root, sessionId, compactFixture(sessionId));

  await recordSessionAutosave({
    cwd: root,
    payload: { session_id: sessionId },
    autosaveAt: "2026-01-02T00:00:00.000Z",
    autosaveTrigger: "stop",
    autosaveSignature: "next",
    autosaveWorkflow: "execute",
    noteRef: noteRef("plan")
  });

  const state = await readState(root, sessionId);
  assert.deepEqual(state?.workflow_route, route);
  assert.equal(state?.last_tool_summary, "previous summary");
  assert.equal(state?.last_wisdom_entry_signature, "wisdom");
  assert.equal(state?.autosave_notes?.execute?.workflow, "execute");
  assert.equal(state?.autosave_notes?.plan?.workflow, "plan");
  assert.equal(state?.artifact_notes?.verify?.workflow, "verify");
  assert.equal(state?.verification_history?.[0]?.tool_summary, "previous");
});

test("compact workflow indexes omit full-only fields and remain less than half the canonical session bytes", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "agmo-runtime-state-compact-size-"));
  const sessionId = "heavy-session";
  const payload = { session_id: sessionId, prompt: "x".repeat(600) };
  await writeWorkflowActivation({
    cwd: root,
    payload,
    workflow: "execute",
    reason: "large fixture",
    workflowRoute: {
      skill: "execute",
      label: "execute",
      reason: "x".repeat(300),
      source: "pattern",
      confidence: "high",
      alternatives: Array.from({ length: 10 }, (_, index) => ({
        skill: `skill-${index}`,
        label: `label-${index}`,
        reason: "alternative reason ".repeat(8),
        score: index
      }))
    }
  });
  await recordSessionAutosave({
    cwd: root,
    payload,
    autosaveAt: "2026-01-01T00:00:00.000Z",
    autosaveTrigger: "stop",
    autosaveSignature: "sig",
    noteRef: {
      ...noteRef("execute"),
      title: "T".repeat(200),
      relative_path: "notes/".padEnd(300, "x")
    }
  });
  await recordSessionArtifact({
    cwd: root,
    payload,
    artifactAt: "2026-01-01T00:00:00.000Z",
    workflow: "verify",
    noteRef: {
      ...noteRef("verify"),
      title: "A".repeat(200),
      relative_path: "artifacts/".padEnd(300, "y")
    }
  });
  await recordSessionActivity({
    cwd: root,
    payload,
    lastEvent: "PostToolUse",
    toolName: "pnpm",
    toolSummary: "summary ".repeat(200),
    toolStatus: "succeeded"
  });
  await recordSessionWisdomPersistence({
    cwd: root,
    payload,
    savedAt: "2026-01-01T00:00:00.000Z",
    signature: "w".repeat(200)
  });

  const { sessionsStateDir, workflowsStateDir } = resolveInstallPaths("project", root);
  const sessionPath = join(sessionsStateDir, `${sessionId}.json`);
  const workflowPath = join(workflowsStateDir, `${sessionId}.json`);
  const sessionBytes = readFileSync(sessionPath).byteLength;
  const workflowBytes = readFileSync(workflowPath).byteLength;
  const workflowRecord = readJson(workflowPath);

  for (const key of [
    "workflow_route",
    "autosave_notes",
    "artifact_notes",
    "verification_history",
    "last_tool_summary",
    "last_wisdom_entry_signature",
    "last_wisdom_entry_saved_at"
  ]) {
    assert.equal(Object.hasOwn(workflowRecord, key), false, `${key} should be omitted`);
  }
  assert.ok(workflowBytes < sessionBytes / 2, `${workflowBytes} should be < half of ${sessionBytes}`);
});

function noteRef(workflow: string): SessionWorkflowNoteRef {
  return {
    workflow,
    type: "artifact",
    title: `${workflow} note`,
    relative_path: `notes/${workflow}.md`,
    wikilink: `[[${workflow} note]]`,
    saved_at: "2026-01-01T00:00:00.000Z"
  };
}
