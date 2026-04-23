import { join } from "node:path";
import { readTextFileIfExists, writeJsonFile } from "../utils/fs.js";
import { resolveInstallPaths } from "../utils/paths.js";

export type AgmoHookPayload = Record<string, unknown>;

export type SessionWorkflowNoteRef = {
  workflow: string;
  type: string;
  title: string;
  relative_path: string;
  wikilink: string;
  saved_at: string;
};

export type VerificationRecord = {
  tool_name: string;
  tool_status: "running" | "succeeded" | "failed";
  tool_summary?: string;
  recorded_at: string;
};

export type SessionState = {
  version: 1;
  session_id: string;
  thread_id?: string;
  turn_id?: string;
  active: boolean;
  last_event: string;
  workflow?: string;
  workflow_reason?: string;
  prompt_excerpt?: string;
  last_tool_name?: string;
  last_tool_summary?: string;
  last_tool_status?: "running" | "succeeded" | "failed";
  last_wisdom_entry_signature?: string;
  last_wisdom_entry_saved_at?: string;
  last_autosave_at?: string;
  last_autosave_trigger?: string;
  last_autosave_signature?: string;
  last_autosave_workflow?: string;
  autosave_notes?: Record<string, SessionWorkflowNoteRef>;
  verification_history?: VerificationRecord[];
  updated_at: string;
  started_at?: string;
  completed_at?: string;
};

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function readOptionalSessionId(payload: AgmoHookPayload): string | null {
  return (
    safeString(payload.session_id) ||
    safeString(payload.sessionId) ||
    safeString(payload.native_session_id) ||
    safeString(payload.nativeSessionId) ||
    safeString(payload.thread_id) ||
    safeString(payload.threadId) ||
    null
  );
}

export function readSessionId(payload: AgmoHookPayload): string {
  return readOptionalSessionId(payload) || "global";
}

export function readThreadId(payload: AgmoHookPayload): string {
  return safeString(payload.thread_id) || safeString(payload.threadId);
}

export function readTurnId(payload: AgmoHookPayload): string {
  return safeString(payload.turn_id) || safeString(payload.turnId);
}

export function readPromptText(payload: AgmoHookPayload): string {
  return (
    safeString(payload.prompt) ||
    safeString(payload.user_prompt) ||
    safeString(payload.userPrompt) ||
    safeString(payload.input)
  );
}

export function safeFileStem(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized || "global";
}

function nowIso(): string {
  return new Date().toISOString();
}

function promptExcerpt(prompt: string): string | undefined {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.slice(0, 240);
}

const MAX_VERIFICATION_HISTORY = 10;

async function writeSessionState(
  cwd: string,
  sessionId: string,
  state: SessionState
): Promise<void> {
  const { sessionsStateDir } = resolveInstallPaths("project", cwd);
  await writeJsonFile(join(sessionsStateDir, `${safeFileStem(sessionId)}.json`), state);
}

async function writeWorkflowState(
  cwd: string,
  sessionId: string,
  state: SessionState
): Promise<void> {
  const { workflowsStateDir } = resolveInstallPaths("project", cwd);
  await writeJsonFile(join(workflowsStateDir, `${safeFileStem(sessionId)}.json`), state);
}

async function readStateFile(path: string): Promise<SessionState | null> {
  const content = await readTextFileIfExists(path);
  if (!content) {
    return null;
  }

  try {
    return JSON.parse(content) as SessionState;
  } catch {
    return null;
  }
}

async function readExistingSessionState(
  cwd: string,
  sessionId: string
): Promise<SessionState | null> {
  const { sessionsStateDir } = resolveInstallPaths("project", cwd);
  return await readStateFile(join(sessionsStateDir, `${safeFileStem(sessionId)}.json`));
}

async function readExistingWorkflowState(
  cwd: string,
  sessionId: string
): Promise<SessionState | null> {
  const { workflowsStateDir } = resolveInstallPaths("project", cwd);
  return await readStateFile(join(workflowsStateDir, `${safeFileStem(sessionId)}.json`));
}

export async function readPersistedSessionState(args: {
  cwd: string;
  payload: AgmoHookPayload;
}): Promise<SessionState | null> {
  const sessionId = readSessionId(args.payload);
  const [existingSession, existingWorkflow] = await Promise.all([
    readExistingSessionState(args.cwd, sessionId),
    readExistingWorkflowState(args.cwd, sessionId)
  ]);

  return existingWorkflow ?? existingSession;
}

function mergeAutosaveState(
  base: SessionState | null | undefined
): Pick<
  SessionState,
  | "last_autosave_at"
  | "last_autosave_trigger"
  | "last_autosave_signature"
  | "last_autosave_workflow"
  | "autosave_notes"
> {
  return {
    ...(base?.last_autosave_at ? { last_autosave_at: base.last_autosave_at } : {}),
    ...(base?.last_autosave_trigger ? { last_autosave_trigger: base.last_autosave_trigger } : {}),
    ...(base?.last_autosave_signature
      ? { last_autosave_signature: base.last_autosave_signature }
      : {}),
    ...(base?.last_autosave_workflow
      ? { last_autosave_workflow: base.last_autosave_workflow }
      : {}),
    ...(base?.autosave_notes ? { autosave_notes: base.autosave_notes } : {})
  };
}

function mergeVerificationState(
  base: SessionState | null | undefined
): Pick<SessionState, "verification_history"> {
  return base?.verification_history?.length
    ? { verification_history: base.verification_history }
    : {};
}

function mergeWisdomPersistenceState(
  base: SessionState | null | undefined
): Pick<SessionState, "last_wisdom_entry_signature" | "last_wisdom_entry_saved_at"> {
  return {
    ...(base?.last_wisdom_entry_signature
      ? { last_wisdom_entry_signature: base.last_wisdom_entry_signature }
      : {}),
    ...(base?.last_wisdom_entry_saved_at
      ? { last_wisdom_entry_saved_at: base.last_wisdom_entry_saved_at }
      : {})
  };
}

function nextVerificationHistory(args: {
  base: SessionState | null | undefined;
  lastEvent: "PreToolUse" | "PostToolUse";
  toolName?: string;
  toolSummary?: string;
  toolStatus?: SessionState["last_tool_status"];
  recordedAt: string;
}): VerificationRecord[] | undefined {
  const { base, lastEvent, toolName, toolSummary, toolStatus, recordedAt } = args;
  if (lastEvent !== "PostToolUse" || !toolStatus) {
    return base?.verification_history;
  }

  const entry: VerificationRecord = {
    tool_name: toolName?.trim() || "tool",
    tool_status: toolStatus,
    ...(toolSummary?.trim() ? { tool_summary: toolSummary.trim() } : {}),
    recorded_at: recordedAt
  };

  return [...(base?.verification_history ?? []), entry].slice(-MAX_VERIFICATION_HISTORY);
}

export async function writeWorkflowActivation(args: {
  cwd: string;
  payload: AgmoHookPayload;
  workflow: string;
  reason: string;
}): Promise<{ sessionId: string; workflowStatePathStem: string }> {
  const sessionId = readSessionId(args.payload);
  const threadId = readThreadId(args.payload);
  const turnId = readTurnId(args.payload);
  const prompt = readPromptText(args.payload);
  const updatedAt = nowIso();
  const [existingSession, existingWorkflow] = await Promise.all([
    readExistingSessionState(args.cwd, sessionId),
    readExistingWorkflowState(args.cwd, sessionId)
  ]);
  const base = existingWorkflow ?? existingSession;

  const state: SessionState = {
    version: 1,
    session_id: sessionId,
    ...(threadId ? { thread_id: threadId } : base?.thread_id ? { thread_id: base.thread_id } : {}),
    ...(turnId ? { turn_id: turnId } : base?.turn_id ? { turn_id: base.turn_id } : {}),
    active: true,
    last_event: "UserPromptSubmit",
    workflow: args.workflow,
    workflow_reason: args.reason,
    ...(promptExcerpt(prompt) ? { prompt_excerpt: promptExcerpt(prompt) } : {}),
    ...mergeAutosaveState(base),
    ...mergeVerificationState(base),
    ...mergeWisdomPersistenceState(base),
    updated_at: updatedAt,
    started_at: updatedAt
  };

  await Promise.all([
    writeSessionState(args.cwd, sessionId, state),
    writeWorkflowState(args.cwd, sessionId, state)
  ]);

  return {
    sessionId,
    workflowStatePathStem: safeFileStem(sessionId)
  };
}

export async function markSessionStopped(args: {
  cwd: string;
  payload: AgmoHookPayload;
}): Promise<{ sessionId: string; workflowStatePathStem: string }> {
  const sessionId = readSessionId(args.payload);
  const threadId = readThreadId(args.payload);
  const turnId = readTurnId(args.payload);
  const updatedAt = nowIso();
  const base = await readPersistedSessionState(args);

  const state: SessionState = {
    version: 1,
    session_id: sessionId,
    ...(threadId ? { thread_id: threadId } : base?.thread_id ? { thread_id: base.thread_id } : {}),
    ...(turnId ? { turn_id: turnId } : base?.turn_id ? { turn_id: base.turn_id } : {}),
    active: false,
    last_event: "Stop",
    ...(base?.workflow ? { workflow: base.workflow } : {}),
    ...(base?.workflow_reason ? { workflow_reason: base.workflow_reason } : {}),
    ...(base?.prompt_excerpt ? { prompt_excerpt: base.prompt_excerpt } : {}),
    ...(base?.last_tool_name ? { last_tool_name: base.last_tool_name } : {}),
    ...(base?.last_tool_summary ? { last_tool_summary: base.last_tool_summary } : {}),
    ...(base?.last_tool_status ? { last_tool_status: base.last_tool_status } : {}),
    ...mergeAutosaveState(base),
    ...mergeVerificationState(base),
    ...mergeWisdomPersistenceState(base),
    updated_at: updatedAt,
    ...(base?.started_at ? { started_at: base.started_at } : {}),
    completed_at: updatedAt
  };

  await Promise.all([
    writeSessionState(args.cwd, sessionId, state),
    writeWorkflowState(args.cwd, sessionId, state)
  ]);

  return {
    sessionId,
    workflowStatePathStem: safeFileStem(sessionId)
  };
}

export async function recordSessionActivity(args: {
  cwd: string;
  payload: AgmoHookPayload;
  lastEvent: "PreToolUse" | "PostToolUse";
  toolName?: string;
  toolSummary?: string;
  toolStatus?: SessionState["last_tool_status"];
}): Promise<{ sessionId: string; workflowStatePathStem: string }> {
  const sessionId = readSessionId(args.payload);
  const threadId = readThreadId(args.payload);
  const turnId = readTurnId(args.payload);
  const updatedAt = nowIso();
  const [existingSession, existingWorkflow] = await Promise.all([
    readExistingSessionState(args.cwd, sessionId),
    readExistingWorkflowState(args.cwd, sessionId)
  ]);
  const base = existingWorkflow ?? existingSession;
  const verificationHistory = nextVerificationHistory({
    base,
    lastEvent: args.lastEvent,
    toolName: args.toolName,
    toolSummary: args.toolSummary,
    toolStatus: args.toolStatus,
    recordedAt: updatedAt
  });

  const nextState: SessionState = {
    version: 1,
    session_id: sessionId,
    ...(threadId ? { thread_id: threadId } : base?.thread_id ? { thread_id: base.thread_id } : {}),
    ...(turnId ? { turn_id: turnId } : base?.turn_id ? { turn_id: base.turn_id } : {}),
    active: true,
    last_event: args.lastEvent,
    ...(base?.workflow ? { workflow: base.workflow } : {}),
    ...(base?.workflow_reason ? { workflow_reason: base.workflow_reason } : {}),
    ...(base?.prompt_excerpt ? { prompt_excerpt: base.prompt_excerpt } : {}),
    ...(args.toolName
      ? { last_tool_name: args.toolName }
      : base?.last_tool_name
        ? { last_tool_name: base.last_tool_name }
        : {}),
    ...(args.toolSummary
      ? { last_tool_summary: args.toolSummary }
      : base?.last_tool_summary
        ? { last_tool_summary: base.last_tool_summary }
        : {}),
    ...(args.toolStatus
      ? { last_tool_status: args.toolStatus }
      : base?.last_tool_status
        ? { last_tool_status: base.last_tool_status }
        : {}),
    ...mergeAutosaveState(base),
    ...(verificationHistory ? { verification_history: verificationHistory } : {}),
    ...mergeWisdomPersistenceState(base),
    updated_at: updatedAt,
    ...(base?.started_at ? { started_at: base.started_at } : { started_at: updatedAt })
  };

  await Promise.all([
    writeSessionState(args.cwd, sessionId, nextState),
    writeWorkflowState(args.cwd, sessionId, nextState)
  ]);

  return {
    sessionId,
    workflowStatePathStem: safeFileStem(sessionId)
  };
}

export async function recordSessionAutosave(args: {
  cwd: string;
  payload: AgmoHookPayload;
  autosaveAt: string;
  autosaveTrigger: string;
  autosaveSignature: string;
  autosaveWorkflow?: string;
  noteRef?: SessionWorkflowNoteRef;
}): Promise<{ sessionId: string; workflowStatePathStem: string }> {
  const sessionId = readSessionId(args.payload);
  const threadId = readThreadId(args.payload);
  const turnId = readTurnId(args.payload);
  const updatedAt = nowIso();
  const [existingSession, existingWorkflow] = await Promise.all([
    readExistingSessionState(args.cwd, sessionId),
    readExistingWorkflowState(args.cwd, sessionId)
  ]);
  const base = existingWorkflow ?? existingSession;

  const nextState: SessionState = {
    version: 1,
    session_id: sessionId,
    ...(threadId ? { thread_id: threadId } : base?.thread_id ? { thread_id: base.thread_id } : {}),
    ...(turnId ? { turn_id: turnId } : base?.turn_id ? { turn_id: base.turn_id } : {}),
    active: base?.active ?? true,
    last_event: base?.last_event ?? "UserPromptSubmit",
    ...(base?.workflow ? { workflow: base.workflow } : {}),
    ...(base?.workflow_reason ? { workflow_reason: base.workflow_reason } : {}),
    ...(base?.prompt_excerpt ? { prompt_excerpt: base.prompt_excerpt } : {}),
    ...(base?.last_tool_name ? { last_tool_name: base.last_tool_name } : {}),
    ...(base?.last_tool_summary ? { last_tool_summary: base.last_tool_summary } : {}),
    ...(base?.last_tool_status ? { last_tool_status: base.last_tool_status } : {}),
    last_autosave_at: args.autosaveAt,
    last_autosave_trigger: args.autosaveTrigger,
    last_autosave_signature: args.autosaveSignature,
    ...(args.autosaveWorkflow ? { last_autosave_workflow: args.autosaveWorkflow } : {}),
    ...(base?.autosave_notes || args.noteRef
      ? {
          autosave_notes: {
            ...(base?.autosave_notes ?? {}),
            ...(args.noteRef ? { [args.noteRef.workflow]: args.noteRef } : {})
          }
        }
      : {}),
    ...mergeVerificationState(base),
    ...mergeWisdomPersistenceState(base),
    updated_at: updatedAt,
    ...(base?.started_at ? { started_at: base.started_at } : {}),
    ...(base?.completed_at ? { completed_at: base.completed_at } : {})
  };

  await Promise.all([
    writeSessionState(args.cwd, sessionId, nextState),
    writeWorkflowState(args.cwd, sessionId, nextState)
  ]);

  return {
    sessionId,
    workflowStatePathStem: safeFileStem(sessionId)
  };
}

export async function recordSessionWisdomPersistence(args: {
  cwd: string;
  payload: AgmoHookPayload;
  savedAt: string;
  signature: string;
}): Promise<{ sessionId: string; workflowStatePathStem: string }> {
  const sessionId = readSessionId(args.payload);
  const threadId = readThreadId(args.payload);
  const turnId = readTurnId(args.payload);
  const updatedAt = nowIso();
  const [existingSession, existingWorkflow] = await Promise.all([
    readExistingSessionState(args.cwd, sessionId),
    readExistingWorkflowState(args.cwd, sessionId)
  ]);
  const base = existingWorkflow ?? existingSession;

  const nextState: SessionState = {
    version: 1,
    session_id: sessionId,
    ...(threadId ? { thread_id: threadId } : base?.thread_id ? { thread_id: base.thread_id } : {}),
    ...(turnId ? { turn_id: turnId } : base?.turn_id ? { turn_id: base.turn_id } : {}),
    active: base?.active ?? true,
    last_event: base?.last_event ?? "UserPromptSubmit",
    ...(base?.workflow ? { workflow: base.workflow } : {}),
    ...(base?.workflow_reason ? { workflow_reason: base.workflow_reason } : {}),
    ...(base?.prompt_excerpt ? { prompt_excerpt: base.prompt_excerpt } : {}),
    ...(base?.last_tool_name ? { last_tool_name: base.last_tool_name } : {}),
    ...(base?.last_tool_summary ? { last_tool_summary: base.last_tool_summary } : {}),
    ...(base?.last_tool_status ? { last_tool_status: base.last_tool_status } : {}),
    ...mergeAutosaveState(base),
    ...mergeVerificationState(base),
    last_wisdom_entry_signature: args.signature,
    last_wisdom_entry_saved_at: args.savedAt,
    updated_at: updatedAt,
    ...(base?.started_at ? { started_at: base.started_at } : {}),
    ...(base?.completed_at ? { completed_at: base.completed_at } : {})
  };

  await Promise.all([
    writeSessionState(args.cwd, sessionId, nextState),
    writeWorkflowState(args.cwd, sessionId, nextState)
  ]);

  return {
    sessionId,
    workflowStatePathStem: safeFileStem(sessionId)
  };
}
