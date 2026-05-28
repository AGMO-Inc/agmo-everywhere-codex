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
  | "read-task"
  | "list-tasks"
  | "get-summary"
  | "claim-task"
  | "transition-task-status";

type TeamApiInput = Record<string, unknown>;

export type TeamApiErrorCode =
  | "invalid_input"
  | "team_not_found"
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

  const status = await readTeamStatus(teamName, cwd);
  if (!status) {
    return buildTeamApiErrorEnvelope(operation, "team_not_found", `team not found: ${teamName}`);
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
