import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readTextFileIfExists } from "../utils/fs.js";
import { resolveInstallPaths } from "../utils/paths.js";
import type { AgmoAgentDefinition } from "../agents/definitions.js";

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

export type WorkflowRouteRecord = {
  skill: string;
  label: string;
  reason: string;
  source: "explicit" | "continuation" | "pattern" | "ambiguous-tie" | "team-escalation";
  confidence: "high" | "medium" | "low";
  operational_category?:
    | "design"
    | "planning"
    | "implementation"
    | "verification"
    | "knowledge"
    | "repo-ops"
    | "issue-ops";
  recommended_agent?:
    | "agmo-planner"
    | "agmo-executor"
    | "agmo-verifier"
    | "agmo-wisdom"
    | "agmo-architect"
    | "agmo-critic"
    | "agmo-explore";
  recommended_effort?: AgmoAgentDefinition["reasoningEffort"];
  verification_strategy?: string;
  score?: number;
  fallback?: string;
  alternatives?: Array<{
    skill: string;
    label: string;
    reason: string;
    score?: number;
  }>;
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
  workflow_route?: WorkflowRouteRecord;
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
  artifact_notes?: Record<string, SessionWorkflowNoteRef>;
  verification_history?: VerificationRecord[];
  updated_at: string;
  started_at?: string;
  completed_at?: string;
};

export type WorkflowStateRef = {
  version: 1;
  kind: "workflow_state_ref";
  session_id: string;
  session_state_ref: string;
  active: boolean;
  status: "active" | "inactive";
  last_event: string;
  workflow?: string;
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
const SESSION_LOCK_TIMEOUT_MS = 5_000;
const SESSION_LOCK_RETRY_MS = 20;
const SESSION_LOCK_METADATA_FILE = "owner.json";

type SessionStateLockMetadata = {
  owner_id: string;
  pid: number;
  acquired_at: string;
};

export type SessionStateLockHandle = {
  lockPath: string;
  ownerId: string;
  release: () => Promise<void>;
};

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sessionStateLockPath(cwd: string, sessionId: string): string {
  const { sessionsStateDir } = resolveInstallPaths("project", cwd);
  return join(dirname(sessionsStateDir), ".session-locks", `${safeFileStem(sessionId)}.lock`);
}

async function readLockOwner(lockPath: string): Promise<string> {
  const metadataPath = join(lockPath, SESSION_LOCK_METADATA_FILE);
  try {
    const raw = await readFile(metadataPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SessionStateLockMetadata>;
    if (
      typeof parsed.owner_id === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.acquired_at === "string"
    ) {
      return `owner=${parsed.owner_id} pid=${parsed.pid} acquired_at=${parsed.acquired_at}`;
    }
    return `malformed_metadata=${JSON.stringify(parsed)}`;
  } catch (error) {
    return `unreadable_metadata=${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function acquireSessionStateLock(
  cwd: string,
  sessionId: string,
  options: { timeoutMs?: number; retryMs?: number; ownerId?: string } = {}
): Promise<SessionStateLockHandle> {
  const lockPath = sessionStateLockPath(cwd, sessionId);
  const metadataPath = join(lockPath, SESSION_LOCK_METADATA_FILE);
  const ownerId = options.ownerId ?? randomUUID();
  const timeoutMs = Math.max(options.timeoutMs ?? SESSION_LOCK_TIMEOUT_MS, 0);
  const retryMs = Math.max(options.retryMs ?? SESSION_LOCK_RETRY_MS, 1);
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(lockPath), { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath);
      const metadata: SessionStateLockMetadata = {
        owner_id: ownerId,
        pid: process.pid,
        acquired_at: new Date().toISOString()
      };
      try {
        await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }

      return {
        lockPath,
        ownerId,
        release: async () => {
          let currentOwner: string | undefined;
          try {
            const parsed = JSON.parse(await readFile(metadataPath, "utf8")) as {
              owner_id?: unknown;
            };
            currentOwner = typeof parsed.owner_id === "string" ? parsed.owner_id : undefined;
          } catch (error) {
            throw new Error(
              `refusing to release session state lock ${lockPath}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
          if (currentOwner !== ownerId) {
            throw new Error(
              `refusing to release session state lock ${lockPath}: owner=${
                currentOwner ?? "unknown"
              } current_owner=${ownerId}`
            );
          }
          await rm(lockPath, { recursive: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    if (Date.now() >= deadline) {
      const owner = await readLockOwner(lockPath);
      throw new Error(
        `timed out waiting for session state lock ${lockPath} for session ${sessionId}; ${owner}. ` +
          "The lock is not reclaimed automatically; inspect and remove it only after confirming its owner is no longer active."
      );
    }
    await sleepMs(Math.min(retryMs, Math.max(1, deadline - Date.now())));
  }
}

async function withSessionStateLock<T>(
  cwd: string,
  sessionId: string,
  callback: () => Promise<T>
): Promise<T> {
  const lock = await acquireSessionStateLock(cwd, sessionId);
  try {
    return await callback();
  } finally {
    await lock.release();
  }
}

async function writeJsonFileAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${safeFileStem(basename(path))}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function writeSessionState(
  cwd: string,
  sessionId: string,
  state: SessionState
): Promise<void> {
  const { sessionsStateDir } = resolveInstallPaths("project", cwd);
  await writeJsonFileAtomically(join(sessionsStateDir, `${safeFileStem(sessionId)}.json`), state);
}

function renderWorkflowStateRef(sessionId: string, state: SessionState): WorkflowStateRef {
  return {
    version: 1,
    kind: "workflow_state_ref",
    session_id: sessionId,
    session_state_ref: `../sessions/${safeFileStem(sessionId)}.json`,
    active: state.active,
    status: state.active ? "active" : "inactive",
    last_event: state.last_event,
    ...(state.workflow ? { workflow: state.workflow } : {}),
    updated_at: state.updated_at,
    ...(state.started_at ? { started_at: state.started_at } : {}),
    ...(state.completed_at ? { completed_at: state.completed_at } : {})
  };
}

async function writeWorkflowState(
  cwd: string,
  sessionId: string,
  state: WorkflowStateRef
): Promise<void> {
  const { workflowsStateDir } = resolveInstallPaths("project", cwd);
  await writeJsonFileAtomically(join(workflowsStateDir, `${safeFileStem(sessionId)}.json`), state);
}

async function persistSessionState(args: {
  cwd: string;
  sessionId: string;
  state: SessionState;
}): Promise<void> {
  await writeSessionState(args.cwd, args.sessionId, args.state);
  await writeWorkflowState(args.cwd, args.sessionId, renderWorkflowStateRef(args.sessionId, args.state));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isSessionState(value: unknown): value is SessionState {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === 1 &&
    value.kind !== "workflow_state_ref" &&
    typeof value.session_id === "string" &&
    value.session_id.trim().length > 0 &&
    typeof value.active === "boolean" &&
    typeof value.last_event === "string" &&
    value.last_event.trim().length > 0 &&
    typeof value.updated_at === "string" &&
    value.updated_at.trim().length > 0
  );
}

export function isWorkflowStateRef(value: unknown): value is WorkflowStateRef {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === 1 &&
    value.kind === "workflow_state_ref" &&
    typeof value.session_id === "string" &&
    value.session_id.trim().length > 0 &&
    typeof value.session_state_ref === "string" &&
    value.session_state_ref.trim().length > 0 &&
    typeof value.active === "boolean" &&
    (value.status === "active" || value.status === "inactive") &&
    typeof value.last_event === "string" &&
    value.last_event.trim().length > 0 &&
    typeof value.updated_at === "string" &&
    value.updated_at.trim().length > 0
  );
}

async function readJsonStateFile(path: string): Promise<unknown | null> {
  const content = await readTextFileIfExists(path);
  if (!content) {
    return null;
  }

  try {
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

async function readSessionStateFile(path: string): Promise<SessionState | null> {
  const parsed = await readJsonStateFile(path);
  return isSessionState(parsed) ? parsed : null;
}

async function readWorkflowStateFile(
  path: string
): Promise<SessionState | WorkflowStateRef | null> {
  const parsed = await readJsonStateFile(path);
  if (isSessionState(parsed) || isWorkflowStateRef(parsed)) {
    return parsed;
  }

  return null;
}

async function readExistingSessionState(
  cwd: string,
  sessionId: string
): Promise<SessionState | null> {
  const { sessionsStateDir } = resolveInstallPaths("project", cwd);
  return await readSessionStateFile(join(sessionsStateDir, `${safeFileStem(sessionId)}.json`));
}

async function readExistingWorkflowState(
  cwd: string,
  sessionId: string
): Promise<SessionState | WorkflowStateRef | null> {
  const { workflowsStateDir } = resolveInstallPaths("project", cwd);
  return await readWorkflowStateFile(join(workflowsStateDir, `${safeFileStem(sessionId)}.json`));
}

function parseUpdatedAt(state: SessionState): number | null {
  const parsed = Date.parse(state.updated_at);
  return Number.isFinite(parsed) ? parsed : null;
}

function chooseNewestSessionState(args: {
  session: SessionState | null;
  workflow: SessionState | null;
}): SessionState | null {
  const { session, workflow } = args;
  if (!session) {
    return workflow;
  }
  if (!workflow) {
    return session;
  }

  const sessionUpdatedAt = parseUpdatedAt(session);
  const workflowUpdatedAt = parseUpdatedAt(workflow);
  if (sessionUpdatedAt !== null && workflowUpdatedAt !== null) {
    return workflowUpdatedAt > sessionUpdatedAt ? workflow : session;
  }
  if (workflowUpdatedAt !== null) {
    return workflow;
  }

  return session;
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

  return chooseNewestSessionState({
    session: existingSession,
    workflow: isSessionState(existingWorkflow) ? existingWorkflow : null
  });
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
  | "artifact_notes"
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
    ...(base?.autosave_notes ? { autosave_notes: base.autosave_notes } : {}),
    ...(base?.artifact_notes ? { artifact_notes: base.artifact_notes } : {})
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

function mergeWorkflowRouteState(
  base: SessionState | null | undefined
): Pick<SessionState, "workflow_route"> {
  return base?.workflow_route ? { workflow_route: base.workflow_route } : {};
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

async function writeWorkflowActivationUnlocked(args: {
  cwd: string;
  payload: AgmoHookPayload;
  workflow: string;
  reason: string;
  workflowRoute?: WorkflowRouteRecord;
}): Promise<{ sessionId: string; workflowStatePathStem: string }> {
  const sessionId = readSessionId(args.payload);
  const threadId = readThreadId(args.payload);
  const turnId = readTurnId(args.payload);
  const prompt = readPromptText(args.payload);
  const updatedAt = nowIso();
  const base = await readPersistedSessionState({
    cwd: args.cwd,
    payload: args.payload
  });

  const state: SessionState = {
    version: 1,
    session_id: sessionId,
    ...(threadId ? { thread_id: threadId } : base?.thread_id ? { thread_id: base.thread_id } : {}),
    ...(turnId ? { turn_id: turnId } : base?.turn_id ? { turn_id: base.turn_id } : {}),
    active: true,
    last_event: "UserPromptSubmit",
    workflow: args.workflow,
    workflow_reason: args.reason,
    ...(args.workflowRoute ? { workflow_route: args.workflowRoute } : {}),
    ...(promptExcerpt(prompt) ? { prompt_excerpt: promptExcerpt(prompt) } : {}),
    ...mergeAutosaveState(base),
    ...mergeVerificationState(base),
    ...mergeWisdomPersistenceState(base),
    updated_at: updatedAt,
    started_at: updatedAt
  };

  await persistSessionState({ cwd: args.cwd, sessionId, state });

  return {
    sessionId,
    workflowStatePathStem: safeFileStem(sessionId)
  };
}

async function markSessionStoppedUnlocked(args: {
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
    ...mergeWorkflowRouteState(base),
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

  await persistSessionState({ cwd: args.cwd, sessionId, state });

  return {
    sessionId,
    workflowStatePathStem: safeFileStem(sessionId)
  };
}

async function recordSessionActivityUnlocked(args: {
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
  const base = await readPersistedSessionState({
    cwd: args.cwd,
    payload: args.payload
  });
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
    ...mergeWorkflowRouteState(base),
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

  await persistSessionState({ cwd: args.cwd, sessionId, state: nextState });

  return {
    sessionId,
    workflowStatePathStem: safeFileStem(sessionId)
  };
}

async function recordSessionAutosaveUnlocked(args: {
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
  const base = await readPersistedSessionState({
    cwd: args.cwd,
    payload: args.payload
  });

  const nextState: SessionState = {
    version: 1,
    session_id: sessionId,
    ...(threadId ? { thread_id: threadId } : base?.thread_id ? { thread_id: base.thread_id } : {}),
    ...(turnId ? { turn_id: turnId } : base?.turn_id ? { turn_id: base.turn_id } : {}),
    active: base?.active ?? true,
    last_event: base?.last_event ?? "UserPromptSubmit",
    ...(base?.workflow ? { workflow: base.workflow } : {}),
    ...(base?.workflow_reason ? { workflow_reason: base.workflow_reason } : {}),
    ...mergeWorkflowRouteState(base),
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
    ...(base?.artifact_notes ? { artifact_notes: base.artifact_notes } : {}),
    ...mergeVerificationState(base),
    ...mergeWisdomPersistenceState(base),
    updated_at: updatedAt,
    ...(base?.started_at ? { started_at: base.started_at } : {}),
    ...(base?.completed_at ? { completed_at: base.completed_at } : {})
  };

  await persistSessionState({ cwd: args.cwd, sessionId, state: nextState });

  return {
    sessionId,
    workflowStatePathStem: safeFileStem(sessionId)
  };
}

async function recordSessionArtifactUnlocked(args: {
  cwd: string;
  payload: AgmoHookPayload;
  artifactAt: string;
  workflow: string;
  noteRef: SessionWorkflowNoteRef;
}): Promise<{ sessionId: string; workflowStatePathStem: string }> {
  const sessionId = readSessionId(args.payload);
  const threadId = readThreadId(args.payload);
  const turnId = readTurnId(args.payload);
  const updatedAt = nowIso();
  const base = await readPersistedSessionState({
    cwd: args.cwd,
    payload: args.payload
  });

  const nextState: SessionState = {
    version: 1,
    session_id: sessionId,
    ...(threadId ? { thread_id: threadId } : base?.thread_id ? { thread_id: base.thread_id } : {}),
    ...(turnId ? { turn_id: turnId } : base?.turn_id ? { turn_id: base.turn_id } : {}),
    active: base?.active ?? true,
    last_event: base?.last_event ?? "UserPromptSubmit",
    ...(base?.workflow ? { workflow: base.workflow } : {}),
    ...(base?.workflow_reason ? { workflow_reason: base.workflow_reason } : {}),
    ...mergeWorkflowRouteState(base),
    ...(base?.prompt_excerpt ? { prompt_excerpt: base.prompt_excerpt } : {}),
    ...(base?.last_tool_name ? { last_tool_name: base.last_tool_name } : {}),
    ...(base?.last_tool_summary ? { last_tool_summary: base.last_tool_summary } : {}),
    ...(base?.last_tool_status ? { last_tool_status: base.last_tool_status } : {}),
    ...mergeAutosaveState(base),
    artifact_notes: {
      ...(base?.artifact_notes ?? {}),
      [args.workflow]: args.noteRef
    },
    ...mergeVerificationState(base),
    ...mergeWisdomPersistenceState(base),
    updated_at: updatedAt,
    ...(base?.started_at ? { started_at: base.started_at } : {}),
    ...(base?.completed_at ? { completed_at: base.completed_at } : {})
  };

  await persistSessionState({ cwd: args.cwd, sessionId, state: nextState });

  return {
    sessionId,
    workflowStatePathStem: safeFileStem(sessionId)
  };
}

async function recordSessionWisdomPersistenceUnlocked(args: {
  cwd: string;
  payload: AgmoHookPayload;
  savedAt: string;
  signature: string;
}): Promise<{ sessionId: string; workflowStatePathStem: string }> {
  const sessionId = readSessionId(args.payload);
  const threadId = readThreadId(args.payload);
  const turnId = readTurnId(args.payload);
  const updatedAt = nowIso();
  const base = await readPersistedSessionState({
    cwd: args.cwd,
    payload: args.payload
  });

  const nextState: SessionState = {
    version: 1,
    session_id: sessionId,
    ...(threadId ? { thread_id: threadId } : base?.thread_id ? { thread_id: base.thread_id } : {}),
    ...(turnId ? { turn_id: turnId } : base?.turn_id ? { turn_id: base.turn_id } : {}),
    active: base?.active ?? true,
    last_event: base?.last_event ?? "UserPromptSubmit",
    ...(base?.workflow ? { workflow: base.workflow } : {}),
    ...(base?.workflow_reason ? { workflow_reason: base.workflow_reason } : {}),
    ...mergeWorkflowRouteState(base),
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

  await persistSessionState({ cwd: args.cwd, sessionId, state: nextState });

  return {
    sessionId,
    workflowStatePathStem: safeFileStem(sessionId)
  };
}

export async function writeWorkflowActivation(
  args: Parameters<typeof writeWorkflowActivationUnlocked>[0]
): Promise<Awaited<ReturnType<typeof writeWorkflowActivationUnlocked>>> {
  const sessionId = readSessionId(args.payload);
  return await withSessionStateLock(args.cwd, sessionId, async () =>
    await writeWorkflowActivationUnlocked(args)
  );
}

export async function markSessionStopped(
  args: Parameters<typeof markSessionStoppedUnlocked>[0]
): Promise<Awaited<ReturnType<typeof markSessionStoppedUnlocked>>> {
  const sessionId = readSessionId(args.payload);
  return await withSessionStateLock(args.cwd, sessionId, async () =>
    await markSessionStoppedUnlocked(args)
  );
}

export async function recordSessionActivity(
  args: Parameters<typeof recordSessionActivityUnlocked>[0]
): Promise<Awaited<ReturnType<typeof recordSessionActivityUnlocked>>> {
  const sessionId = readSessionId(args.payload);
  return await withSessionStateLock(args.cwd, sessionId, async () =>
    await recordSessionActivityUnlocked(args)
  );
}

export async function recordSessionAutosave(
  args: Parameters<typeof recordSessionAutosaveUnlocked>[0]
): Promise<Awaited<ReturnType<typeof recordSessionAutosaveUnlocked>>> {
  const sessionId = readSessionId(args.payload);
  return await withSessionStateLock(args.cwd, sessionId, async () =>
    await recordSessionAutosaveUnlocked(args)
  );
}

export async function recordSessionArtifact(
  args: Parameters<typeof recordSessionArtifactUnlocked>[0]
): Promise<Awaited<ReturnType<typeof recordSessionArtifactUnlocked>>> {
  const sessionId = readSessionId(args.payload);
  return await withSessionStateLock(args.cwd, sessionId, async () =>
    await recordSessionArtifactUnlocked(args)
  );
}

export async function recordSessionWisdomPersistence(
  args: Parameters<typeof recordSessionWisdomPersistenceUnlocked>[0]
): Promise<Awaited<ReturnType<typeof recordSessionWisdomPersistenceUnlocked>>> {
  const sessionId = readSessionId(args.payload);
  return await withSessionStateLock(args.cwd, sessionId, async () =>
    await recordSessionWisdomPersistenceUnlocked(args)
  );
}
