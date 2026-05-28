import { machineJsonEnvelope } from "../utils/machine-json.js";
import {
  claimTaskForWorker,
  broadcastWorkerMessage,
  completeTaskForWorker,
  createTeamTask,
  failTaskForWorker,
  listWorkerMailboxMessages,
  markWorkerMailboxMessageDelivered,
  markWorkerMailboxMessageNotified,
  releaseTaskClaimForWorker,
  sendWorkerMessage,
  updateTeamTask,
  updateWorkerHeartbeatState,
  writeWorkerIdentityState,
  writeWorkerInboxContent,
  appendTeamApiEvent,
  readTeamApiEvents,
  awaitTeamApiEvent,
  readTeamStatus
} from "./runtime.js";
import type { AgmoTeamTaskStatus } from "./state/tasks.js";

export type TeamApiOperation =
  | "send-message"
  | "broadcast"
  | "mailbox-list"
  | "mailbox-mark-delivered"
  | "mailbox-mark-notified"
  | "create-task"
  | "update-task"
  | "release-task-claim"
  | "read-config"
  | "read-manifest"
  | "read-worker-status"
  | "read-worker-heartbeat"
  | "update-worker-heartbeat"
  | "write-worker-inbox"
  | "write-worker-identity"
  | "append-event"
  | "read-events"
  | "await-event"
  | "read-task"
  | "list-tasks"
  | "get-summary"
  | "claim-task"
  | "transition-task-status";

type TeamApiInput = Record<string, unknown>;

export type TeamApiErrorCode =
  | "invalid_input"
  | "team_not_found"
  | "manifest_not_found"
  | "task_not_found"
  | "claim_conflict"
  | "invalid_transition"
  | "lease_expired"
  | "worker_not_found"
  | "runtime_error";

type TeamApiError = {
  code: TeamApiErrorCode;
  message: string;
};

export type TeamApiEnvelope = {
  schema_version: "1.0";
  operation: TeamApiOperation;
  ok: boolean;
  command: string;
  data?: unknown;
  error?: TeamApiError;
};

const TASK_STATUSES: AgmoTeamTaskStatus[] = [
  "pending",
  "blocked",
  "in_progress",
  "completed",
  "failed"
];
const UPDATE_TASK_MUTABLE_FIELDS = new Set([
  "team_name",
  "task_id",
  "subject",
  "description",
  "blocked_by",
  "depends_on",
  "requires_code_change"
]);
const UPDATE_TASK_LIFECYCLE_FIELDS = [
  "status",
  "owner",
  "role",
  "claim",
  "claim_history",
  "assignment_history",
  "result",
  "error",
  "version",
  "created_at",
  "updated_at"
];
const TEAM_API_EVENT_TYPES = [
  "task_completed",
  "task_failed",
  "worker_state_changed",
  "worker_idle",
  "worker_stopped",
  "message_received",
  "leader_notification_deferred",
  "all_workers_idle",
  "shutdown_ack",
  "shutdown_gate",
  "shutdown_gate_forced",
  "ralph_cleanup_policy",
  "ralph_cleanup_summary",
  "approval_decision",
  "team_leader_nudge",
  "worker_diff_activity",
  "worker_diff_report",
  "worker_merge_report",
  "worker_merge_conflict",
  "worker_integration_failed",
  "worker_integration_attempt_requested",
  "worker_cherry_pick_detected",
  "worker_cherry_pick_applied",
  "worker_cherry_pick_conflict",
  "worker_rebase_applied",
  "worker_rebase_conflict",
  "worker_cross_rebase_applied",
  "worker_cross_rebase_conflict",
  "worker_cross_rebase_skipped",
  "worker_stale_diff",
  "worker_stale_heartbeat",
  "worker_stale_stdout",
  "team_started",
  "team_shutdown",
  "shutdown_acknowledged",
  "leader_escalation_alert",
  "leader_alert_delivery",
  "leader_alert_delivery_configured",
  "team_hud_repaired",
  "worker_message_sent",
  "mailbox_message_notified",
  "mailbox_message_delivered",
  "dispatch_acknowledged",
  "dispatch_retry",
  "task_claim_blocked",
  "task_claimed",
  "task_created",
  "task_updated",
  "task_claim_released",
  "worker_heartbeat",
  "worker_status_reported",
  "worker_hook_activity",
  "team_monitor_snapshot",
  "leader_auto_nudge",
  "task_claim_reclaimed",
  "task_rebalanced",
  "task_integrated",
  "task_integration_conflict",
  "task_integration_failed"
] as const;
type TeamApiEventType = (typeof TEAM_API_EVENT_TYPES)[number];
const TEAM_API_WAKEABLE_EVENT_TYPES = new Set<TeamApiEventType>([
  "worker_state_changed",
  "task_completed",
  "task_failed",
  "worker_stopped",
  "message_received",
  "leader_notification_deferred",
  "all_workers_idle",
  "team_leader_nudge",
  "worker_integration_failed",
  "worker_integration_attempt_requested",
  "worker_merge_conflict",
  "worker_cherry_pick_conflict",
  "worker_rebase_conflict",
  "worker_cross_rebase_conflict",
  "worker_stale_diff",
  "worker_stale_heartbeat",
  "worker_stale_stdout",
  "team_shutdown",
  "shutdown_acknowledged",
  "task_integration_conflict",
  "task_integration_failed"
]);

export function buildTeamApiErrorEnvelope(
  operation: TeamApiOperation,
  code: TeamApiErrorCode,
  message: string
): TeamApiEnvelope {
  return machineJsonEnvelope(operation, false, {
    command: `team api ${operation}`,
    error: { code, message }
  }) as TeamApiEnvelope;
}

function dataEnvelope(operation: TeamApiOperation, data: unknown): TeamApiEnvelope {
  return machineJsonEnvelope(operation, true, {
    command: `team api ${operation}`,
    data
  }) as TeamApiEnvelope;
}

function parseInput(inputJson: string): TeamApiInput | TeamApiError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch (error) {
    return {
      code: "invalid_input",
      message: `--input must be valid JSON: ${(error as Error).message}`
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      code: "invalid_input",
      message: "--input must be a JSON object"
    };
  }

  return parsed as TeamApiInput;
}

function requiredString(input: TeamApiInput, fieldName: string): string | TeamApiError {
  const value = input[fieldName];
  if (typeof value !== "string" || !value.trim()) {
    return {
      code: "invalid_input",
      message: `${fieldName} is required`
    };
  }
  return value;
}

function optionalString(input: TeamApiInput, fieldName: string): string | TeamApiError | undefined {
  const value = input[fieldName];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return {
      code: "invalid_input",
      message: `${fieldName} must be a string when provided`
    };
  }
  return value;
}

function optionalBoolean(input: TeamApiInput, fieldName: string): boolean | TeamApiError | undefined {
  const value = input[fieldName];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    return {
      code: "invalid_input",
      message: `${fieldName} must be a boolean when provided`
    };
  }
  return value;
}

function optionalStringArray(input: TeamApiInput, fieldName: string): string[] | TeamApiError | undefined {
  const value = input[fieldName];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return {
      code: "invalid_input",
      message: `${fieldName} must be an array of strings when provided`
    };
  }
  const output: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      return {
        code: "invalid_input",
        message: `${fieldName} entries must be non-empty strings`
      };
    }
    output.push(entry.trim());
  }
  return output;
}

function optionalPositiveInteger(input: TeamApiInput, fieldName: string): number | TeamApiError | undefined {
  const value = input[fieldName];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return {
      code: "invalid_input",
      message: `${fieldName} must be a positive integer when provided`
    };
  }
  return value;
}

function optionalNonNegativeInteger(input: TeamApiInput, fieldName: string): number | TeamApiError | undefined {
  const value = input[fieldName];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return {
      code: "invalid_input",
      message: `${fieldName} must be a non-negative integer when provided`
    };
  }
  return value;
}

function requiredPositiveInteger(input: TeamApiInput, fieldName: string): number | TeamApiError {
  const value = input[fieldName];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return {
      code: "invalid_input",
      message: `${fieldName} must be a positive integer`
    };
  }
  return value;
}

function requiredNonNegativeInteger(input: TeamApiInput, fieldName: string): number | TeamApiError {
  const value = input[fieldName];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return {
      code: "invalid_input",
      message: `${fieldName} must be a non-negative integer`
    };
  }
  return value;
}

function requiredBoolean(input: TeamApiInput, fieldName: string): boolean | TeamApiError {
  const value = input[fieldName];
  if (typeof value !== "boolean") {
    return {
      code: "invalid_input",
      message: `${fieldName} must be a boolean`
    };
  }
  return value;
}

function optionalNullableString(input: TeamApiInput, fieldName: string): string | null | TeamApiError | undefined {
  const value = input[fieldName];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return {
      code: "invalid_input",
      message: `${fieldName} must be a string or null when provided`
    };
  }
  return value;
}

function optionalRecord(input: TeamApiInput, fieldName: string): Record<string, unknown> | TeamApiError | undefined {
  const value = input[fieldName];
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      code: "invalid_input",
      message: `${fieldName} must be an object when provided`
    };
  }
  return value as Record<string, unknown>;
}

function requiredTaskStatus(input: TeamApiInput, fieldName: string): AgmoTeamTaskStatus | TeamApiError {
  const value = requiredString(input, fieldName);
  if (isTeamApiError(value)) {
    return value;
  }
  if (!TASK_STATUSES.includes(value as AgmoTeamTaskStatus)) {
    return {
      code: "invalid_input",
      message: `${fieldName} must be one of: ${TASK_STATUSES.join(", ")}`
    };
  }
  return value as AgmoTeamTaskStatus;
}

function requiredEventType(input: TeamApiInput, fieldName: string): TeamApiEventType | TeamApiError {
  const value = requiredString(input, fieldName);
  if (isTeamApiError(value)) {
    return value;
  }
  if (!TEAM_API_EVENT_TYPES.includes(value as TeamApiEventType)) {
    return {
      code: "invalid_input",
      message: `${fieldName} must be one of: ${TEAM_API_EVENT_TYPES.join(", ")}`
    };
  }
  return value as TeamApiEventType;
}

function optionalEventType(input: TeamApiInput, fieldName: string): TeamApiEventType | TeamApiError | undefined {
  const value = optionalString(input, fieldName);
  if (value === undefined || isTeamApiError(value)) {
    return value;
  }
  if (!TEAM_API_EVENT_TYPES.includes(value as TeamApiEventType)) {
    return {
      code: "invalid_input",
      message: `${fieldName} must be one of: ${TEAM_API_EVENT_TYPES.join(", ")}`
    };
  }
  return value as TeamApiEventType;
}

function isTeamApiError(value: unknown): value is TeamApiError {
  return Boolean(
    value &&
      typeof value === "object" &&
      "code" in value &&
      "message" in value
  );
}

function buildTaskCounts(tasks: Array<{ status: AgmoTeamTaskStatus }>): Record<AgmoTeamTaskStatus, number> {
  return Object.fromEntries(
    TASK_STATUSES.map((status) => [
      status,
      tasks.filter((task) => task.status === status).length
    ])
  ) as Record<AgmoTeamTaskStatus, number>;
}

function workerExists(
  status: Awaited<ReturnType<typeof readTeamStatus>>,
  worker: string
): boolean {
  return Boolean(status?.workers.some((candidate) => candidate.identity.name === worker));
}

function mapRuntimeError(error: unknown): TeamApiError {
  const message = error instanceof Error ? error.message : String(error);
  if (/claim conflict|owned by|claim token mismatch|no active claim/i.test(message)) {
    return { code: "claim_conflict", message };
  }
  if (/invalid transition/i.test(message)) {
    return { code: "invalid_transition", message };
  }
  if (/lease expired/i.test(message)) {
    return { code: "lease_expired", message };
  }
  if (/task not found/i.test(message)) {
    return { code: "task_not_found", message };
  }
  if (/worker not found|worker identity not found/i.test(message)) {
    return { code: "worker_not_found", message };
  }
  if (/team not found/i.test(message)) {
    return { code: "team_not_found", message };
  }
  return { code: "runtime_error", message };
}

export async function executeTeamApiOperation(
  operation: TeamApiOperation,
  inputJson: string | undefined,
  cwd: string
): Promise<TeamApiEnvelope> {
  if (inputJson === undefined) {
    return buildTeamApiErrorEnvelope(operation, "invalid_input", "--input is required");
  }

  const input = parseInput(inputJson);
  if (isTeamApiError(input)) {
    return buildTeamApiErrorEnvelope(operation, input.code, input.message);
  }

  const teamName = requiredString(input, "team_name");
  if (isTeamApiError(teamName)) {
    return buildTeamApiErrorEnvelope(operation, teamName.code, teamName.message);
  }

  let status: Awaited<ReturnType<typeof readTeamStatus>>;
  try {
    status = await readTeamStatus(teamName, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (operation === "read-manifest" && /team state incomplete/i.test(message)) {
      return buildTeamApiErrorEnvelope(operation, "manifest_not_found", `manifest not found: ${teamName}`);
    }
    return buildTeamApiErrorEnvelope(operation, "runtime_error", message);
  }
  if (!status) {
    return buildTeamApiErrorEnvelope(operation, "team_not_found", `team not found: ${teamName}`);
  }

  if (operation === "read-config") {
    return dataEnvelope(operation, { config: status.config });
  }

  if (operation === "read-manifest") {
    if (!status.manifest) {
      return buildTeamApiErrorEnvelope(operation, "manifest_not_found", `manifest not found: ${teamName}`);
    }
    return dataEnvelope(operation, { manifest: status.manifest });
  }

  if (operation === "read-worker-status") {
    const worker = requiredString(input, "worker");
    if (isTeamApiError(worker)) {
      return buildTeamApiErrorEnvelope(operation, worker.code, worker.message);
    }
    const workerState = status.workers.find((candidate) => candidate.identity.name === worker);
    if (!workerState) {
      return buildTeamApiErrorEnvelope(operation, "worker_not_found", `worker not found: ${worker}`);
    }
    return dataEnvelope(operation, { worker, status: workerState.status });
  }

  if (operation === "read-worker-heartbeat") {
    const worker = requiredString(input, "worker");
    if (isTeamApiError(worker)) {
      return buildTeamApiErrorEnvelope(operation, worker.code, worker.message);
    }
    const workerState = status.workers.find((candidate) => candidate.identity.name === worker);
    if (!workerState) {
      return buildTeamApiErrorEnvelope(operation, "worker_not_found", `worker not found: ${worker}`);
    }
    return dataEnvelope(operation, { worker, heartbeat: workerState.heartbeat });
  }

  if (operation === "update-worker-heartbeat") {
    const worker = requiredString(input, "worker");
    const turnCount = requiredNonNegativeInteger(input, "turn_count");
    const alive = requiredBoolean(input, "alive");
    const pid = optionalPositiveInteger(input, "pid");
    const lastTurnAt = optionalString(input, "last_turn_at");
    if (isTeamApiError(worker)) {
      return buildTeamApiErrorEnvelope(operation, worker.code, worker.message);
    }
    if (isTeamApiError(turnCount)) {
      return buildTeamApiErrorEnvelope(operation, turnCount.code, turnCount.message);
    }
    if (isTeamApiError(alive)) {
      return buildTeamApiErrorEnvelope(operation, alive.code, alive.message);
    }
    if (isTeamApiError(pid)) {
      return buildTeamApiErrorEnvelope(operation, pid.code, pid.message);
    }
    if (isTeamApiError(lastTurnAt)) {
      return buildTeamApiErrorEnvelope(operation, lastTurnAt.code, lastTurnAt.message);
    }
    if (!workerExists(status, worker)) {
      return buildTeamApiErrorEnvelope(operation, "worker_not_found", `worker not found: ${worker}`);
    }
    try {
      return dataEnvelope(
        operation,
        await updateWorkerHeartbeatState(
          teamName,
          worker,
          {
            turnCount,
            alive,
            ...(pid !== undefined ? { pid } : {}),
            ...(lastTurnAt !== undefined ? { lastTurnAt } : {})
          },
          cwd
        )
      );
    } catch (error) {
      const mapped = mapRuntimeError(error);
      return buildTeamApiErrorEnvelope(operation, mapped.code, mapped.message);
    }
  }

  if (operation === "write-worker-inbox") {
    const worker = requiredString(input, "worker");
    const content = requiredString(input, "content");
    if (isTeamApiError(worker)) {
      return buildTeamApiErrorEnvelope(operation, worker.code, worker.message);
    }
    if (isTeamApiError(content)) {
      return buildTeamApiErrorEnvelope(operation, content.code, content.message);
    }
    if (!workerExists(status, worker)) {
      return buildTeamApiErrorEnvelope(operation, "worker_not_found", `worker not found: ${worker}`);
    }
    try {
      return dataEnvelope(
        operation,
        await writeWorkerInboxContent(teamName, worker, content, cwd)
      );
    } catch (error) {
      const mapped = mapRuntimeError(error);
      return buildTeamApiErrorEnvelope(operation, mapped.code, mapped.message);
    }
  }

  if (operation === "write-worker-identity") {
    const worker = requiredString(input, "worker");
    const index = requiredPositiveInteger(input, "index");
    const role = requiredString(input, "role");
    const workingDir = optionalString(input, "working_dir");
    const worktreePath = optionalString(input, "worktree_path");
    const teamStateRoot = optionalString(input, "team_state_root");
    const paneId = optionalString(input, "pane_id");
    const gitBranch = optionalString(input, "git_branch");
    if (isTeamApiError(worker)) {
      return buildTeamApiErrorEnvelope(operation, worker.code, worker.message);
    }
    if (isTeamApiError(index)) {
      return buildTeamApiErrorEnvelope(operation, index.code, index.message);
    }
    if (isTeamApiError(role)) {
      return buildTeamApiErrorEnvelope(operation, role.code, role.message);
    }
    if (isTeamApiError(workingDir)) {
      return buildTeamApiErrorEnvelope(operation, workingDir.code, workingDir.message);
    }
    if (isTeamApiError(worktreePath)) {
      return buildTeamApiErrorEnvelope(operation, worktreePath.code, worktreePath.message);
    }
    if (isTeamApiError(teamStateRoot)) {
      return buildTeamApiErrorEnvelope(operation, teamStateRoot.code, teamStateRoot.message);
    }
    if (isTeamApiError(paneId)) {
      return buildTeamApiErrorEnvelope(operation, paneId.code, paneId.message);
    }
    if (isTeamApiError(gitBranch)) {
      return buildTeamApiErrorEnvelope(operation, gitBranch.code, gitBranch.message);
    }
    if (!workerExists(status, worker)) {
      return buildTeamApiErrorEnvelope(operation, "worker_not_found", `worker not found: ${worker}`);
    }
    try {
      return dataEnvelope(
        operation,
        await writeWorkerIdentityState(
          teamName,
          worker,
          {
            index,
            role,
            ...(workingDir !== undefined ? { workingDir } : {}),
            ...(worktreePath !== undefined ? { worktreePath } : {}),
            ...(teamStateRoot !== undefined ? { teamStateRoot } : {}),
            ...(paneId !== undefined ? { paneId } : {}),
            ...(gitBranch !== undefined ? { gitBranch } : {})
          },
          cwd
        )
      );
    } catch (error) {
      const mapped = mapRuntimeError(error);
      return buildTeamApiErrorEnvelope(operation, mapped.code, mapped.message);
    }
  }

  if (operation === "append-event") {
    const type = requiredEventType(input, "type");
    const worker = requiredString(input, "worker");
    const taskId = optionalString(input, "task_id");
    const messageId = optionalNullableString(input, "message_id");
    const reason = optionalString(input, "reason");
    const state = optionalString(input, "state");
    const prevState = optionalString(input, "prev_state");
    const toWorker = optionalString(input, "to_worker");
    const workerCount = optionalNonNegativeInteger(input, "worker_count");
    const sourceType = optionalString(input, "source_type");
    const metadata = optionalRecord(input, "metadata");
    if (isTeamApiError(type)) {
      return buildTeamApiErrorEnvelope(operation, type.code, type.message);
    }
    if (isTeamApiError(worker)) {
      return buildTeamApiErrorEnvelope(operation, worker.code, worker.message);
    }
    if (isTeamApiError(taskId)) {
      return buildTeamApiErrorEnvelope(operation, taskId.code, taskId.message);
    }
    if (isTeamApiError(messageId)) {
      return buildTeamApiErrorEnvelope(operation, messageId.code, messageId.message);
    }
    if (isTeamApiError(reason)) {
      return buildTeamApiErrorEnvelope(operation, reason.code, reason.message);
    }
    if (isTeamApiError(state)) {
      return buildTeamApiErrorEnvelope(operation, state.code, state.message);
    }
    if (isTeamApiError(prevState)) {
      return buildTeamApiErrorEnvelope(operation, prevState.code, prevState.message);
    }
    if (isTeamApiError(toWorker)) {
      return buildTeamApiErrorEnvelope(operation, toWorker.code, toWorker.message);
    }
    if (isTeamApiError(workerCount)) {
      return buildTeamApiErrorEnvelope(operation, workerCount.code, workerCount.message);
    }
    if (isTeamApiError(sourceType)) {
      return buildTeamApiErrorEnvelope(operation, sourceType.code, sourceType.message);
    }
    if (isTeamApiError(metadata)) {
      return buildTeamApiErrorEnvelope(operation, metadata.code, metadata.message);
    }
    const isLeaderEvent = worker === "leader" || worker === "leader-fixed";
    if (!isLeaderEvent && !workerExists(status, worker)) {
      return buildTeamApiErrorEnvelope(operation, "worker_not_found", `worker not found: ${worker}`);
    }
    try {
      return dataEnvelope(
        operation,
        await appendTeamApiEvent(
          teamName,
          {
            type,
            worker,
            ...(taskId !== undefined ? { taskId } : {}),
            ...(messageId !== undefined ? { messageId } : {}),
            ...(reason !== undefined ? { reason } : {}),
            ...(state !== undefined ? { state } : {}),
            ...(prevState !== undefined ? { prevState } : {}),
            ...(toWorker !== undefined ? { toWorker } : {}),
            ...(workerCount !== undefined ? { workerCount } : {}),
            ...(sourceType !== undefined ? { sourceType } : {}),
            ...(metadata !== undefined ? { metadata } : {})
          },
          cwd
        )
      );
    } catch (error) {
      const mapped = mapRuntimeError(error);
      return buildTeamApiErrorEnvelope(operation, mapped.code, mapped.message);
    }
  }

  if (operation === "read-events") {
    const afterEventId = optionalString(input, "after_event_id");
    const wakeableOnly = optionalBoolean(input, "wakeable_only");
    const type = optionalEventType(input, "type");
    const worker = optionalString(input, "worker");
    const taskId = optionalString(input, "task_id");
    if (isTeamApiError(afterEventId)) {
      return buildTeamApiErrorEnvelope(operation, afterEventId.code, afterEventId.message);
    }
    if (isTeamApiError(wakeableOnly)) {
      return buildTeamApiErrorEnvelope(operation, wakeableOnly.code, wakeableOnly.message);
    }
    if (isTeamApiError(type)) {
      return buildTeamApiErrorEnvelope(operation, type.code, type.message);
    }
    if (isTeamApiError(worker)) {
      return buildTeamApiErrorEnvelope(operation, worker.code, worker.message);
    }
    if (isTeamApiError(taskId)) {
      return buildTeamApiErrorEnvelope(operation, taskId.code, taskId.message);
    }
    try {
      const result = await readTeamApiEvents(
        teamName,
        {
          ...(afterEventId !== undefined ? { afterEventId } : {}),
          wakeableOnly: wakeableOnly ?? false,
          ...(type !== undefined ? { type } : {}),
          ...(worker !== undefined ? { worker } : {}),
          ...(taskId !== undefined ? { taskId } : {}),
          wakeableEventTypes: [...TEAM_API_WAKEABLE_EVENT_TYPES]
        },
        cwd
      );
      return dataEnvelope(operation, result);
    } catch (error) {
      const mapped = mapRuntimeError(error);
      return buildTeamApiErrorEnvelope(operation, mapped.code, mapped.message);
    }
  }

  if (operation === "await-event") {
    const afterEventId = optionalString(input, "after_event_id");
    const timeoutMs = optionalNonNegativeInteger(input, "timeout_ms");
    const pollMs = optionalNonNegativeInteger(input, "poll_ms");
    const wakeableOnly = optionalBoolean(input, "wakeable_only");
    const type = optionalEventType(input, "type");
    const worker = optionalString(input, "worker");
    const taskId = optionalString(input, "task_id");
    if (isTeamApiError(afterEventId)) {
      return buildTeamApiErrorEnvelope(operation, afterEventId.code, afterEventId.message);
    }
    if (isTeamApiError(timeoutMs)) {
      return buildTeamApiErrorEnvelope(operation, timeoutMs.code, timeoutMs.message);
    }
    if (isTeamApiError(pollMs)) {
      return buildTeamApiErrorEnvelope(operation, pollMs.code, pollMs.message);
    }
    if (isTeamApiError(wakeableOnly)) {
      return buildTeamApiErrorEnvelope(operation, wakeableOnly.code, wakeableOnly.message);
    }
    if (isTeamApiError(type)) {
      return buildTeamApiErrorEnvelope(operation, type.code, type.message);
    }
    if (isTeamApiError(worker)) {
      return buildTeamApiErrorEnvelope(operation, worker.code, worker.message);
    }
    if (isTeamApiError(taskId)) {
      return buildTeamApiErrorEnvelope(operation, taskId.code, taskId.message);
    }
    try {
      const result = await awaitTeamApiEvent(
        teamName,
        {
          ...(afterEventId !== undefined ? { afterEventId } : {}),
          timeoutMs: timeoutMs ?? 30_000,
          ...(pollMs !== undefined ? { pollMs } : {}),
          wakeableOnly: wakeableOnly ?? false,
          ...(type !== undefined ? { type } : {}),
          ...(worker !== undefined ? { worker } : {}),
          ...(taskId !== undefined ? { taskId } : {}),
          wakeableEventTypes: [...TEAM_API_WAKEABLE_EVENT_TYPES]
        },
        cwd
      );
      return dataEnvelope(operation, result);
    } catch (error) {
      const mapped = mapRuntimeError(error);
      return buildTeamApiErrorEnvelope(operation, mapped.code, mapped.message);
    }
  }

  if (operation === "send-message") {
    const fromWorker = requiredString(input, "from_worker");
    const toWorker = requiredString(input, "to_worker");
    const body = requiredString(input, "body");
    if (isTeamApiError(fromWorker)) {
      return buildTeamApiErrorEnvelope(operation, fromWorker.code, fromWorker.message);
    }
    if (isTeamApiError(toWorker)) {
      return buildTeamApiErrorEnvelope(operation, toWorker.code, toWorker.message);
    }
    if (isTeamApiError(body)) {
      return buildTeamApiErrorEnvelope(operation, body.code, body.message);
    }
    try {
      const dispatch = await sendWorkerMessage(teamName, toWorker, body, cwd, { fromWorker });
      const mailbox = await listWorkerMailboxMessages(teamName, toWorker, {}, cwd);
      const message = mailbox.messages.find(
        (entry) => entry.message_id === dispatch.message_id
      );
      if (!message) {
        throw new Error(`send-message could not locate persisted mailbox message for ${fromWorker} -> ${toWorker}`);
      }
      return dataEnvelope(operation, {
        message,
        dispatch
      });
    } catch (error) {
      const mapped = mapRuntimeError(error);
      return buildTeamApiErrorEnvelope(operation, mapped.code, mapped.message);
    }
  }

  if (operation === "broadcast") {
    const fromWorker = requiredString(input, "from_worker");
    const body = requiredString(input, "body");
    if (isTeamApiError(fromWorker)) {
      return buildTeamApiErrorEnvelope(operation, fromWorker.code, fromWorker.message);
    }
    if (isTeamApiError(body)) {
      return buildTeamApiErrorEnvelope(operation, body.code, body.message);
    }
    try {
      return dataEnvelope(operation, await broadcastWorkerMessage(teamName, fromWorker, body, cwd));
    } catch (error) {
      const mapped = mapRuntimeError(error);
      return buildTeamApiErrorEnvelope(operation, mapped.code, mapped.message);
    }
  }

  if (operation === "mailbox-list") {
    const worker = requiredString(input, "worker");
    const includeDelivered = optionalBoolean(input, "include_delivered");
    if (isTeamApiError(worker)) {
      return buildTeamApiErrorEnvelope(operation, worker.code, worker.message);
    }
    if (isTeamApiError(includeDelivered)) {
      return buildTeamApiErrorEnvelope(operation, includeDelivered.code, includeDelivered.message);
    }
    try {
      return dataEnvelope(
        operation,
        await listWorkerMailboxMessages(teamName, worker, { includeDelivered }, cwd)
      );
    } catch (error) {
      const mapped = mapRuntimeError(error);
      return buildTeamApiErrorEnvelope(operation, mapped.code, mapped.message);
    }
  }

  if (operation === "mailbox-mark-delivered") {
    const worker = requiredString(input, "worker");
    const messageId = requiredString(input, "message_id");
    if (isTeamApiError(worker)) {
      return buildTeamApiErrorEnvelope(operation, worker.code, worker.message);
    }
    if (isTeamApiError(messageId)) {
      return buildTeamApiErrorEnvelope(operation, messageId.code, messageId.message);
    }
    try {
      return dataEnvelope(
        operation,
        await markWorkerMailboxMessageDelivered(teamName, worker, messageId, cwd)
      );
    } catch (error) {
      const mapped = mapRuntimeError(error);
      return buildTeamApiErrorEnvelope(operation, mapped.code, mapped.message);
    }
  }

  if (operation === "mailbox-mark-notified") {
    const worker = requiredString(input, "worker");
    const messageId = requiredString(input, "message_id");
    if (isTeamApiError(worker)) {
      return buildTeamApiErrorEnvelope(operation, worker.code, worker.message);
    }
    if (isTeamApiError(messageId)) {
      return buildTeamApiErrorEnvelope(operation, messageId.code, messageId.message);
    }
    try {
      return dataEnvelope(
        operation,
        await markWorkerMailboxMessageNotified(teamName, worker, messageId, cwd)
      );
    } catch (error) {
      const mapped = mapRuntimeError(error);
      return buildTeamApiErrorEnvelope(operation, mapped.code, mapped.message);
    }
  }

  if (operation === "create-task") {
    const subject = requiredString(input, "subject");
    const description = requiredString(input, "description");
    const owner = optionalString(input, "owner");
    const role = optionalString(input, "role");
    const blockedBy = optionalStringArray(input, "blocked_by");
    const dependsOn = optionalStringArray(input, "depends_on");
    const requiresCodeChange = optionalBoolean(input, "requires_code_change");
    if (isTeamApiError(subject)) {
      return buildTeamApiErrorEnvelope(operation, subject.code, subject.message);
    }
    if (isTeamApiError(description)) {
      return buildTeamApiErrorEnvelope(operation, description.code, description.message);
    }
    if (isTeamApiError(owner)) {
      return buildTeamApiErrorEnvelope(operation, owner.code, owner.message);
    }
    if (isTeamApiError(role)) {
      return buildTeamApiErrorEnvelope(operation, role.code, role.message);
    }
    if (isTeamApiError(blockedBy)) {
      return buildTeamApiErrorEnvelope(operation, blockedBy.code, blockedBy.message);
    }
    if (isTeamApiError(dependsOn)) {
      return buildTeamApiErrorEnvelope(operation, dependsOn.code, dependsOn.message);
    }
    if (blockedBy !== undefined && dependsOn !== undefined) {
      return buildTeamApiErrorEnvelope(
        operation,
        "invalid_input",
        "provide only one of blocked_by or depends_on"
      );
    }
    if (isTeamApiError(requiresCodeChange)) {
      return buildTeamApiErrorEnvelope(operation, requiresCodeChange.code, requiresCodeChange.message);
    }
    try {
      return dataEnvelope(
        operation,
        await createTeamTask(
          teamName,
          {
            subject,
            description,
            ...(owner ? { owner } : {}),
            ...(role ? { role } : {}),
            ...(blockedBy !== undefined || dependsOn !== undefined
              ? { dependsOn: blockedBy ?? dependsOn ?? [] }
              : {}),
            ...(requiresCodeChange !== undefined
              ? { requiresCodeChange }
              : {})
          },
          cwd
        )
      );
    } catch (error) {
      const mapped = mapRuntimeError(error);
      return buildTeamApiErrorEnvelope(operation, mapped.code, mapped.message);
    }
  }

  if (operation === "update-task") {
    const taskId = requiredString(input, "task_id");
    if (isTeamApiError(taskId)) {
      return buildTeamApiErrorEnvelope(operation, taskId.code, taskId.message);
    }
    const lifecycleFields = UPDATE_TASK_LIFECYCLE_FIELDS.filter((field) => field in input);
    if (lifecycleFields.length > 0) {
      return buildTeamApiErrorEnvelope(
        operation,
        "invalid_input",
        `update-task cannot mutate lifecycle fields: ${lifecycleFields.join(", ")}`
      );
    }
    const unsupportedFields = Object.keys(input).filter(
      (field) => !UPDATE_TASK_MUTABLE_FIELDS.has(field)
    );
    if (unsupportedFields.length > 0) {
      return buildTeamApiErrorEnvelope(
        operation,
        "invalid_input",
        `update-task received unsupported fields: ${unsupportedFields.join(", ")}`
      );
    }
    const subject = optionalString(input, "subject");
    const description = optionalString(input, "description");
    const blockedBy = optionalStringArray(input, "blocked_by");
    const dependsOn = optionalStringArray(input, "depends_on");
    const requiresCodeChange = optionalBoolean(input, "requires_code_change");
    if (isTeamApiError(subject)) {
      return buildTeamApiErrorEnvelope(operation, subject.code, subject.message);
    }
    if (isTeamApiError(description)) {
      return buildTeamApiErrorEnvelope(operation, description.code, description.message);
    }
    if (isTeamApiError(blockedBy)) {
      return buildTeamApiErrorEnvelope(operation, blockedBy.code, blockedBy.message);
    }
    if (isTeamApiError(dependsOn)) {
      return buildTeamApiErrorEnvelope(operation, dependsOn.code, dependsOn.message);
    }
    if (blockedBy !== undefined && dependsOn !== undefined) {
      return buildTeamApiErrorEnvelope(
        operation,
        "invalid_input",
        "provide only one of blocked_by or depends_on"
      );
    }
    if (isTeamApiError(requiresCodeChange)) {
      return buildTeamApiErrorEnvelope(operation, requiresCodeChange.code, requiresCodeChange.message);
    }
    try {
      return dataEnvelope(
        operation,
        await updateTeamTask(
          teamName,
          taskId,
          {
            ...(subject !== undefined ? { subject } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(blockedBy !== undefined || dependsOn !== undefined
              ? { dependsOn: blockedBy ?? dependsOn ?? [] }
              : {}),
            ...(requiresCodeChange !== undefined
              ? { requiresCodeChange }
              : {})
          },
          cwd
        )
      );
    } catch (error) {
      const mapped = mapRuntimeError(error);
      return buildTeamApiErrorEnvelope(operation, mapped.code, mapped.message);
    }
  }

  if (operation === "release-task-claim") {
    const taskId = requiredString(input, "task_id");
    const worker = requiredString(input, "worker");
    const claimToken = requiredString(input, "claim_token");
    if (isTeamApiError(taskId)) {
      return buildTeamApiErrorEnvelope(operation, taskId.code, taskId.message);
    }
    if (isTeamApiError(worker)) {
      return buildTeamApiErrorEnvelope(operation, worker.code, worker.message);
    }
    if (isTeamApiError(claimToken)) {
      return buildTeamApiErrorEnvelope(operation, claimToken.code, claimToken.message);
    }
    try {
      return dataEnvelope(
        operation,
        await releaseTaskClaimForWorker(teamName, taskId, worker, claimToken, cwd)
      );
    } catch (error) {
      const mapped = mapRuntimeError(error);
      return buildTeamApiErrorEnvelope(operation, mapped.code, mapped.message);
    }
  }

  if (operation === "claim-task") {
    const taskId = requiredString(input, "task_id");
    const worker = requiredString(input, "worker");
    const expectedVersion = optionalPositiveInteger(input, "expected_version");
    if (isTeamApiError(taskId)) {
      return buildTeamApiErrorEnvelope(operation, taskId.code, taskId.message);
    }
    if (isTeamApiError(worker)) {
      return buildTeamApiErrorEnvelope(operation, worker.code, worker.message);
    }
    if (isTeamApiError(expectedVersion)) {
      return buildTeamApiErrorEnvelope(operation, expectedVersion.code, expectedVersion.message);
    }
    const task = status.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      return buildTeamApiErrorEnvelope(operation, "task_not_found", `task not found: ${taskId}`);
    }
    if (task.status === "completed" || task.status === "failed") {
      return buildTeamApiErrorEnvelope(
        operation,
        "invalid_transition",
        `cannot claim terminal task ${taskId}`
      );
    }
    if (task.status === "in_progress") {
      return buildTeamApiErrorEnvelope(
        operation,
        "claim_conflict",
        `task ${taskId} is already in_progress`
      );
    }
    try {
      return dataEnvelope(
        operation,
        await claimTaskForWorker(
          teamName,
          taskId,
          worker,
          {
            expectedVersion
          },
          cwd
        )
      );
    } catch (error) {
      const mapped = mapRuntimeError(error);
      return buildTeamApiErrorEnvelope(operation, mapped.code, mapped.message);
    }
  }

  if (operation === "transition-task-status") {
    const taskId = requiredString(input, "task_id");
    const from = requiredTaskStatus(input, "from");
    const to = requiredTaskStatus(input, "to");
    const claimToken = requiredString(input, "claim_token");
    const result = optionalString(input, "result");
    const taskError = optionalString(input, "error");
    if (isTeamApiError(taskId)) {
      return buildTeamApiErrorEnvelope(operation, taskId.code, taskId.message);
    }
    if (isTeamApiError(from)) {
      return buildTeamApiErrorEnvelope(operation, from.code, from.message);
    }
    if (isTeamApiError(to)) {
      return buildTeamApiErrorEnvelope(operation, to.code, to.message);
    }
    if (isTeamApiError(claimToken)) {
      return buildTeamApiErrorEnvelope(operation, claimToken.code, claimToken.message);
    }
    if (isTeamApiError(result)) {
      return buildTeamApiErrorEnvelope(operation, result.code, result.message);
    }
    if (isTeamApiError(taskError)) {
      return buildTeamApiErrorEnvelope(operation, taskError.code, taskError.message);
    }
    const task = status.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      return buildTeamApiErrorEnvelope(operation, "task_not_found", `task not found: ${taskId}`);
    }
    if (from !== "in_progress" || (to !== "completed" && to !== "failed")) {
      return buildTeamApiErrorEnvelope(
        operation,
        "invalid_transition",
        "transition-task-status supports in_progress -> completed|failed"
      );
    }
    if (task.status !== from) {
      return buildTeamApiErrorEnvelope(
        operation,
        "invalid_transition",
        `invalid transition: expected ${from}, found ${task.status}`
      );
    }
    const worker = task.claim?.owner ?? task.owner;
    if (!worker) {
      return buildTeamApiErrorEnvelope(
        operation,
        "claim_conflict",
        `task ${taskId} has no active owner`
      );
    }
    try {
      const payload = to === "completed"
        ? await completeTaskForWorker(
            teamName,
            taskId,
            worker,
            result,
            cwd,
            { claimToken, expectedStatus: from }
          )
        : await failTaskForWorker(
            teamName,
            taskId,
            worker,
            taskError,
            cwd,
            { claimToken, expectedStatus: from }
          );
      return dataEnvelope(operation, payload);
    } catch (error) {
      const mapped = mapRuntimeError(error);
      return buildTeamApiErrorEnvelope(operation, mapped.code, mapped.message);
    }
  }

  if (operation === "list-tasks") {
    return dataEnvelope(operation, {
      team_name: teamName,
      tasks: status.tasks
    });
  }

  if (operation === "read-task") {
    const taskId = requiredString(input, "task_id");
    if (isTeamApiError(taskId)) {
      return buildTeamApiErrorEnvelope(operation, taskId.code, taskId.message);
    }
    const task = status.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      return buildTeamApiErrorEnvelope(operation, "task_not_found", `task not found: ${taskId}`);
    }
    return dataEnvelope(operation, {
      team_name: teamName,
      task
    });
  }

  return dataEnvelope(operation, {
    team_name: teamName,
    active: status.phase.active,
    phase: status.phase.current_phase,
    worker_count: status.config.worker_count,
    task_counts: buildTaskCounts(status.tasks),
    workers: status.workers.map((worker) => ({
      worker_name: worker.identity.name,
      role: worker.identity.role,
      state: worker.status.state,
      current_task_id: worker.status.current_task_id ?? null
    }))
  });
}
