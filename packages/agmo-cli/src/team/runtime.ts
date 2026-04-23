import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { buildHookCommand, mergeManagedHooksConfig } from "../hooks/codex-hooks.js";
import { agmoCliDistEntryPath } from "../utils/paths.js";
import {
  buildInitialTaskLanesWithOverrides,
  type AgmoTaskIntent
} from "./role-router.js";
import {
  createTeamSession,
  describeTmuxSessionTopology,
  destroyWorkerPanes,
  notifyPane,
  type TmuxTopology
} from "./tmux-session.js";
import {
  buildInitialWorkerInbox,
  buildWorkerInstructions
} from "./worker-bootstrap.js";
import { provisionWorkerWorktree } from "./worktree.js";
import {
  buildDefaultWorkerHeartbeat,
  buildDefaultWorkerStatus,
  buildShutdownWorkerHeartbeat,
  buildShutdownWorkerStatus,
  buildWorkerNames,
  createMessageId,
  generateTeamName,
  nowIso,
  resolveTeamConfigPath,
  resolveTeamDir,
  resolveTeamDispatchPath,
  resolveTeamLeaderAlertDeliveryLogPath,
  resolveTeamLeaderAlertDeliveryPath,
  resolveTeamLeaderAlertMailboxJsonlPath,
  resolveTeamLeaderAlertMailboxMarkdownPath,
  resolveTeamEventsPath,
  resolveTeamLeaderEscalationsPath,
  resolveTeamIntegrationAssistPath,
  resolveTeamIntegrationsPath,
  resolveTeamLeaderHudPath,
  resolveTeamLeaderMonitorViewPath,
  resolveTeamLeaderNudgesPath,
  resolveTeamMonitorPolicyPath,
  resolveTeamMailboxDir,
  resolveTeamManifestPath,
  resolveTeamMonitorSnapshotPath,
  resolveTeamPhasePath,
  resolveTeamStateRoot,
  resolveTeamTaskPath,
  resolveTeamTasksDir,
  resolveWorkerDir,
  resolveWorkerHeartbeatPath,
  resolveWorkerIdentityPath,
  resolveWorkerInboxPath,
  resolveWorkerInstructionsPath,
  resolveWorkerMailboxPath,
  resolveWorkerStatusPath,
  sanitizeTeamName,
  type AgmoTeamConfig,
  type AgmoTeamManifest,
  type AgmoTeamPhaseState,
  type AgmoTeamStatusSnapshot,
  type AgmoWorkerIdentity
} from "./state/index.js";
import type {
  AgmoLeaderAlertDeliveryAttempt,
  AgmoLeaderAlertDeliveryChannel,
  AgmoLeaderAlertDeliveryLog,
  AgmoLeaderAlertDeliveryState
} from "./state/alerts.js";
import type { AgmoDispatchRequest } from "./state/dispatch.js";
import type {
  AgmoLeaderEscalationKind,
  AgmoLeaderEscalationRecord,
  AgmoLeaderEscalationState,
  AgmoLeaderEscalationSeverity
} from "./state/escalations.js";
import type {
  AgmoIntegrationBatchOrder,
  AgmoIntegrationConflictPolicy,
  AgmoIntegrationEmptyPolicy,
  AgmoIntegrationStrategy,
  AgmoTeamIntegrationAttempt,
  AgmoTeamIntegrationState,
  AgmoIntegrationTargetSource
} from "./state/integrations.js";
import type { AgmoMailboxMessage } from "./state/mailbox.js";
import type {
  AgmoTeamMonitorSnapshot,
  AgmoWorkerHeartbeat,
  AgmoWorkerHealth,
  AgmoWorkerMonitorSnapshot,
  AgmoWorkerStatus
} from "./state/monitor.js";
import type {
  AgmoLeaderNudgeRecord,
  AgmoLeaderNudgeState
} from "./state/nudges.js";
import type {
  AgmoMonitorPolicyPreset,
  AgmoTeamMonitorPolicyState
} from "./state/policy.js";
import type { AgmoTeamTaskRecord, AgmoTeamTaskStatus } from "./state/tasks.js";
import { DEFAULT_TASK_CLAIM_LEASE_MS } from "./state/locks.js";
import { ensureDir, readTextFileIfExists, writeJsonFile, writeTextFile } from "../utils/fs.js";

export type TeamRuntimeMode = "interactive";
export type TeamTmuxSpawnIntent = "live-team-runtime";

export type TeamStartRequest = {
  teamName?: string;
  workerCount: number;
  task: string;
  mode: TeamRuntimeMode;
  sessionId?: string | null;
  spawnTmuxPanes?: boolean;
  tmuxSpawnIntent?: TeamTmuxSpawnIntent;
  hud?: boolean;
  hudRefreshMs?: number;
  hudClearScreen?: boolean;
  allocationIntent?: AgmoTaskIntent;
  roleOverrides?: Record<string, string>;
};

type AgmoLeaderAlertDeliveryResult = {
  team_name: string;
  attempts: AgmoLeaderAlertDeliveryAttempt[];
  config_path: string;
  mailbox_markdown_path: string;
  mailbox_jsonl_path: string;
};

const LEADER_ALERT_DELIVERY_HISTORY_LIMIT = 200;
const DEFAULT_SENDMAIL_PATH = "/usr/sbin/sendmail";
const DEFAULT_EMAIL_FROM = "agmo@localhost";
const DEFAULT_EMAIL_SUBJECT_PREFIX = "[AGMO Leader Alert]";

function assertValidWorkerCount(workerCount: number): void {
  if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 20) {
    throw new Error("workerCount must be an integer between 1 and 20");
  }
}

export function shouldSpawnTeamTmuxPanes(
  request: Pick<TeamStartRequest, "spawnTmuxPanes" | "tmuxSpawnIntent">,
  tmux: Pick<TmuxTopology, "available" | "in_tmux_client">
): boolean {
  return (
    request.spawnTmuxPanes === true &&
    request.tmuxSpawnIntent === "live-team-runtime" &&
    tmux.available &&
    tmux.in_tmux_client
  );
}

function resolveTeamSessionId(
  requestSessionId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const candidates = [requestSessionId, env.AGMO_LAUNCH_SESSION_ID];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  const content = await readTextFileIfExists(path);
  if (!content) {
    return null;
  }

  return JSON.parse(content) as T;
}

async function readTaskRecord(
  teamName: string,
  taskId: string,
  cwd = process.cwd()
): Promise<AgmoTeamTaskRecord> {
  const task = await readJsonFile<AgmoTeamTaskRecord>(
    resolveTeamTaskPath(teamName, taskId, cwd)
  );

  if (!task) {
    throw new Error(`task not found: ${teamName}/${taskId}`);
  }

  return task;
}

function parseCsvList(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function maskWebhookUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  try {
    const parsed = new URL(value);
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const tail = pathParts.slice(-2).join("/");
    return `${parsed.origin}/…/${tail || "configured"}`;
  } catch {
    return "configured";
  }
}

function resolveLeaderAlertDeliveryState(
  stored?: AgmoLeaderAlertDeliveryState | null
): AgmoLeaderAlertDeliveryState {
  const envSlackWebhook = process.env.AGMO_LEADER_ALERT_SLACK_WEBHOOK_URL?.trim();
  const envEmailTo = parseCsvList(process.env.AGMO_LEADER_ALERT_EMAIL_TO);
  const envEmailFrom = process.env.AGMO_LEADER_ALERT_EMAIL_FROM?.trim();
  const envEmailSendmailPath = process.env.AGMO_LEADER_ALERT_EMAIL_SENDMAIL_PATH?.trim();
  const envEmailSubjectPrefix = process.env.AGMO_LEADER_ALERT_EMAIL_SUBJECT_PREFIX?.trim();

  const slackWebhookUrl = stored?.slack.webhook_url?.trim() || envSlackWebhook;
  const emailRecipients =
    stored?.email.to && stored.email.to.length > 0 ? stored.email.to : envEmailTo;
  const emailFrom = stored?.email.from?.trim() || envEmailFrom || DEFAULT_EMAIL_FROM;
  const emailSendmailPath =
    stored?.email.sendmail_path?.trim() || envEmailSendmailPath || DEFAULT_SENDMAIL_PATH;
  const emailSubjectPrefix =
    stored?.email.subject_prefix?.trim() ||
    envEmailSubjectPrefix ||
    DEFAULT_EMAIL_SUBJECT_PREFIX;

  return {
    updated_at: stored?.updated_at ?? nowIso(),
    mailbox: {
      enabled: stored?.mailbox.enabled ?? true
    },
    slack: {
      enabled: stored?.slack.enabled ?? Boolean(slackWebhookUrl),
      ...(slackWebhookUrl ? { webhook_url: slackWebhookUrl } : {}),
      ...(stored?.slack.username?.trim() ? { username: stored.slack.username.trim() } : {}),
      ...(stored?.slack.icon_emoji?.trim()
        ? { icon_emoji: stored.slack.icon_emoji.trim() }
        : {})
    },
    email: {
      enabled: stored?.email.enabled ?? emailRecipients.length > 0,
      to: emailRecipients,
      ...(emailFrom ? { from: emailFrom } : {}),
      ...(emailSendmailPath ? { sendmail_path: emailSendmailPath } : {}),
      ...(emailSubjectPrefix ? { subject_prefix: emailSubjectPrefix } : {})
    }
  };
}

function redactLeaderAlertDeliveryState(
  state: AgmoLeaderAlertDeliveryState
): Record<string, unknown> {
  return {
    updated_at: state.updated_at,
    mailbox: state.mailbox,
    slack: {
      enabled: state.slack.enabled,
      webhook_configured: Boolean(state.slack.webhook_url),
      webhook_hint: maskWebhookUrl(state.slack.webhook_url),
      ...(state.slack.username ? { username: state.slack.username } : {}),
      ...(state.slack.icon_emoji ? { icon_emoji: state.slack.icon_emoji } : {})
    },
    email: {
      enabled: state.email.enabled,
      to: state.email.to,
      recipient_count: state.email.to.length,
      ...(state.email.from ? { from: state.email.from } : {}),
      ...(state.email.sendmail_path ? { sendmail_path: state.email.sendmail_path } : {}),
      ...(state.email.subject_prefix
        ? { subject_prefix: state.email.subject_prefix }
        : {})
    }
  };
}

async function readLeaderAlertDeliveryConfig(
  teamName: string,
  cwd = process.cwd()
): Promise<AgmoLeaderAlertDeliveryState | null> {
  return await readJsonFile<AgmoLeaderAlertDeliveryState>(
    resolveTeamLeaderAlertDeliveryPath(teamName, cwd)
  );
}

async function writeLeaderAlertDeliveryConfig(
  teamName: string,
  state: AgmoLeaderAlertDeliveryState,
  cwd = process.cwd()
): Promise<void> {
  await writeJsonFile(resolveTeamLeaderAlertDeliveryPath(teamName, cwd), state);
}

async function readLeaderAlertDeliveryLog(
  teamName: string,
  cwd = process.cwd()
): Promise<AgmoLeaderAlertDeliveryLog | null> {
  return await readJsonFile<AgmoLeaderAlertDeliveryLog>(
    resolveTeamLeaderAlertDeliveryLogPath(teamName, cwd)
  );
}

async function appendLeaderAlertDeliveryAttempts(
  teamName: string,
  attempts: AgmoLeaderAlertDeliveryAttempt[],
  cwd = process.cwd()
): Promise<void> {
  if (attempts.length === 0) {
    return;
  }

  const current =
    (await readLeaderAlertDeliveryLog(teamName, cwd)) ?? {
      updated_at: attempts[attempts.length - 1]?.attempted_at ?? nowIso(),
      attempts: []
    };
  current.updated_at = attempts[attempts.length - 1]?.attempted_at ?? nowIso();
  current.attempts = [...current.attempts, ...attempts].slice(
    -LEADER_ALERT_DELIVERY_HISTORY_LIMIT
  );

  await writeJsonFile(resolveTeamLeaderAlertDeliveryLogPath(teamName, cwd), current);
}

function formatLeaderAlertText(
  teamName: string,
  alert: AgmoLeaderEscalationRecord
): string {
  const reasons =
    alert.reasons.length > 0 ? `Reasons: ${alert.reasons.join(", ")}` : "Reasons: none";
  return [
    `Leader alert for team ${teamName}`,
    `Worker: ${alert.worker_name}`,
    `Kind: ${alert.kind}`,
    `Severity: ${alert.severity}`,
    `Repeat count: ${alert.repeat_count}`,
    reasons,
    `First seen: ${alert.first_seen_at}`,
    `Last seen: ${alert.last_seen_at}`
  ].join("\n");
}

function formatLeaderAlertSlackText(
  teamName: string,
  alert: AgmoLeaderEscalationRecord
): string {
  const reasons = alert.reasons.length > 0 ? ` — ${alert.reasons.join(", ")}` : "";
  return [
    `:rotating_light: AGMO leader alert`,
    `team=${teamName}`,
    `worker=${alert.worker_name}`,
    `kind=${alert.kind}`,
    `severity=${alert.severity}`,
    `repeat=${alert.repeat_count}${reasons}`
  ].join(" | ");
}

function formatLeaderAlertEmailMessage(
  teamName: string,
  alert: AgmoLeaderEscalationRecord,
  config: AgmoLeaderAlertDeliveryState
): string {
  const from = config.email.from ?? DEFAULT_EMAIL_FROM;
  const subjectPrefix = config.email.subject_prefix ?? DEFAULT_EMAIL_SUBJECT_PREFIX;
  return [
    `From: ${from}`,
    `To: ${config.email.to.join(", ")}`,
    `Subject: ${subjectPrefix} ${teamName} ${alert.worker_name} ${alert.kind}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    formatLeaderAlertText(teamName, alert)
  ].join("\n");
}

async function writeTaskRecord(
  teamName: string,
  task: AgmoTeamTaskRecord,
  cwd = process.cwd()
): Promise<void> {
  await writeJsonFile(resolveTeamTaskPath(teamName, task.id, cwd), task);
}

function buildShutdownTaskRecord(
  task: AgmoTeamTaskRecord,
  timestamp: string
): AgmoTeamTaskRecord {
  const releaseHistory = task.claim
    ? [
        ...(task.claim_history ?? []),
        {
          owner: task.claim.owner,
          claimed_at: task.claim.claimed_at,
          released_at: timestamp,
          release_reason: "team_shutdown"
        }
      ]
    : task.claim_history;

  if (task.status === "completed" || task.status === "failed") {
    return {
      ...task,
      ...(task.claim ? { claim: undefined } : {}),
      ...(releaseHistory ? { claim_history: releaseHistory } : {}),
      updated_at: timestamp
    };
  }

  return {
    ...task,
    status: "failed",
    error: task.error ?? "Team runtime shut down before task completion.",
    claim: undefined,
    ...(releaseHistory ? { claim_history: releaseHistory } : {}),
    updated_at: timestamp
  };
}

async function readWorkerIdentity(
  teamName: string,
  workerName: string,
  cwd = process.cwd()
): Promise<AgmoWorkerIdentity> {
  const identity = await readJsonFile<AgmoWorkerIdentity>(
    resolveWorkerIdentityPath(teamName, workerName, cwd)
  );
  if (!identity) {
    throw new Error(`worker identity not found: ${teamName}/${workerName}`);
  }
  return identity;
}

async function writeWorkerStatus(
  teamName: string,
  workerName: string,
  status: AgmoWorkerStatus,
  cwd = process.cwd()
): Promise<void> {
  await writeJsonFile(resolveWorkerStatusPath(teamName, workerName, cwd), status);
}

async function writeWorkerHeartbeat(
  teamName: string,
  workerName: string,
  heartbeat: AgmoWorkerHeartbeat,
  cwd = process.cwd()
): Promise<void> {
  await writeJsonFile(resolveWorkerHeartbeatPath(teamName, workerName, cwd), heartbeat);
}

async function readWorkerStatusRecord(
  teamName: string,
  workerName: string,
  cwd = process.cwd()
): Promise<AgmoWorkerStatus> {
  return (
    (await readJsonFile<AgmoWorkerStatus>(
      resolveWorkerStatusPath(teamName, workerName, cwd)
    )) ?? buildDefaultWorkerStatus()
  );
}

async function bumpWorkerHeartbeat(
  teamName: string,
  workerName: string,
  options: {
    pid?: number;
  } = {},
  cwd = process.cwd()
): Promise<void> {
  const current =
    (await readJsonFile<AgmoWorkerHeartbeat>(
      resolveWorkerHeartbeatPath(teamName, workerName, cwd)
    )) ?? buildDefaultWorkerHeartbeat();
  const next: AgmoWorkerHeartbeat = {
    ...current,
    ...(options.pid ? { pid: options.pid } : {}),
    alive: true,
    turn_count: current.turn_count + 1,
    last_turn_at: nowIso()
  };
  await writeWorkerHeartbeat(teamName, workerName, next, cwd);
}

async function appendMailboxMessage(
  teamName: string,
  workerName: string,
  message: AgmoMailboxMessage,
  cwd = process.cwd()
): Promise<void> {
  const mailboxPath = resolveWorkerMailboxPath(teamName, workerName, cwd);
  const current = (await readJsonFile<AgmoMailboxMessage[]>(mailboxPath)) ?? [];
  current.push(message);

  await Promise.all([
    writeJsonFile(mailboxPath, current),
    appendFile(
      resolveWorkerInboxPath(teamName, workerName, cwd),
      `\n---\n\n## Message ${message.message_id}\n\nFrom: ${message.from_worker}\nAt: ${message.created_at}\n\n${message.body}\n`,
      "utf-8"
    )
  ]);
}

async function readDispatchRequests(
  teamName: string,
  cwd = process.cwd()
): Promise<AgmoDispatchRequest[]> {
  return (
    (await readJsonFile<AgmoDispatchRequest[]>(resolveTeamDispatchPath(teamName, cwd))) ?? []
  );
}

async function writeDispatchRequests(
  teamName: string,
  requests: AgmoDispatchRequest[],
  cwd = process.cwd()
): Promise<void> {
  await writeJsonFile(resolveTeamDispatchPath(teamName, cwd), requests);
}

async function updateMailboxMessage(
  teamName: string,
  workerName: string,
  messageId: string,
  patch: Partial<AgmoMailboxMessage>,
  cwd = process.cwd()
): Promise<void> {
  const mailboxPath = resolveWorkerMailboxPath(teamName, workerName, cwd);
  const mailbox = (await readJsonFile<AgmoMailboxMessage[]>(mailboxPath)) ?? [];
  const nextMailbox = mailbox.map((entry) =>
    entry.message_id === messageId ? { ...entry, ...patch } : entry
  );
  await writeJsonFile(mailboxPath, nextMailbox);
}

function assertWorkerOwnsTask(task: AgmoTeamTaskRecord, workerName: string): void {
  if (task.owner && task.owner !== workerName) {
    throw new Error(
      `task ${task.id} is owned by ${task.owner}, cannot operate as ${workerName}`
    );
  }
}

function computeTaskDependencyBlockers(
  task: AgmoTeamTaskRecord,
  tasksById: Map<string, AgmoTeamTaskRecord>
): NonNullable<AgmoTeamTaskRecord["blocked_by_dependencies"]> {
  const dependencies = task.depends_on ?? [];
  const blockers: NonNullable<AgmoTeamTaskRecord["blocked_by_dependencies"]> = [];

  for (const dependencyId of dependencies) {
    const dependency = tasksById.get(dependencyId);
    if (!dependency) {
      blockers.push({
        task_id: dependencyId,
        status: "missing",
        reason: "dependency_missing"
      });
      continue;
    }

    if (dependency.status === "failed") {
      blockers.push({
        task_id: dependencyId,
        status: dependency.status,
        reason: "dependency_failed"
      });
      continue;
    }

    if (dependency.status !== "completed") {
      blockers.push({
        task_id: dependencyId,
        status: dependency.status,
        reason: "dependency_not_completed"
      });
    }
  }

  return blockers;
}

async function refreshTeamDependencyStates(
  teamName: string,
  cwd = process.cwd()
): Promise<{
  team_name: string;
  updated: Array<{
    task_id: string;
    previous_status: AgmoTeamTaskStatus;
    next_status: AgmoTeamTaskStatus;
    blocked_by_dependencies: NonNullable<AgmoTeamTaskRecord["blocked_by_dependencies"]>;
    worker_notified: boolean;
  }>;
}> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const status = await readTeamStatus(normalizedTeamName, cwd);
  if (!status) {
    throw new Error(`team not found: ${normalizedTeamName}`);
  }

  const tasksById = new Map(status.tasks.map((task) => [task.id, task]));
  const updated: Array<{
    task_id: string;
    previous_status: AgmoTeamTaskStatus;
    next_status: AgmoTeamTaskStatus;
    blocked_by_dependencies: NonNullable<AgmoTeamTaskRecord["blocked_by_dependencies"]>;
    worker_notified: boolean;
  }> = [];

  for (const task of status.tasks) {
    if (task.status === "in_progress" || task.status === "completed" || task.status === "failed") {
      continue;
    }

    const blockers = computeTaskDependencyBlockers(task, tasksById);
    const nextStatus: AgmoTeamTaskStatus = blockers.length > 0 ? "blocked" : "pending";
    const blockedByChanged =
      JSON.stringify(task.blocked_by_dependencies ?? []) !== JSON.stringify(blockers);
    const statusChanged = task.status !== nextStatus;

    if (!blockedByChanged && !statusChanged) {
      continue;
    }

    const nextTask: AgmoTeamTaskRecord = {
      ...task,
      status: nextStatus,
      blocked_by_dependencies: blockers.length > 0 ? blockers : undefined,
      version: task.version + 1,
      updated_at: nowIso()
    };
    await writeTaskRecord(normalizedTeamName, nextTask, cwd);
    let workerNotified = false;
    if (nextStatus === "pending" && task.status === "blocked" && nextTask.owner) {
      await sendWorkerMessage(
        normalizedTeamName,
        nextTask.owner,
        [
          `Task ${nextTask.id} is now unblocked in team ${normalizedTeamName}.`,
          `You can claim it when ready.`,
          `Task summary: ${nextTask.subject}`
        ].join(" "),
        cwd
      );
      workerNotified = true;
    }

    updated.push({
      task_id: task.id,
      previous_status: task.status,
      next_status: nextStatus,
      blocked_by_dependencies: blockers,
      worker_notified: workerNotified
    });

    await writeEvent(
      normalizedTeamName,
      {
        timestamp: nextTask.updated_at,
        type:
          nextStatus === "blocked"
            ? "task_dependencies_blocked"
            : "task_dependencies_unblocked",
        team_name: normalizedTeamName,
        task_id: task.id,
        previous_status: task.status,
        next_status: nextStatus,
        blocked_by_dependencies: blockers,
        worker_notified: workerNotified
      },
      cwd
    );
  }

  return {
    team_name: normalizedTeamName,
    updated
  };
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      return true;
    }
    return false;
  }
}

function parseTimestampMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function resolveReportedWorkerPid(): number | undefined {
  const raw = process.env.AGMO_WORKER_PID;
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function buildWorkerNudgeFingerprint(worker: AgmoWorkerMonitorSnapshot): string {
  return JSON.stringify({
    health: worker.health,
    reasons: worker.reasons.filter((reason) => reason !== "pending_dispatch").sort(),
    current_task_id: worker.current_task_id,
    claim_at_risk: worker.claim_at_risk
  });
}

async function readLeaderNudgeState(
  teamName: string,
  cwd = process.cwd()
): Promise<AgmoLeaderNudgeState | null> {
  return await readJsonFile<AgmoLeaderNudgeState>(
    resolveTeamLeaderNudgesPath(teamName, cwd)
  );
}

async function writeLeaderNudgeState(
  teamName: string,
  state: AgmoLeaderNudgeState,
  cwd = process.cwd()
): Promise<void> {
  await writeJsonFile(resolveTeamLeaderNudgesPath(teamName, cwd), state);
}

async function readLeaderEscalationState(
  teamName: string,
  cwd = process.cwd()
): Promise<AgmoLeaderEscalationState | null> {
  return await readJsonFile<AgmoLeaderEscalationState>(
    resolveTeamLeaderEscalationsPath(teamName, cwd)
  );
}

async function writeLeaderEscalationState(
  teamName: string,
  state: AgmoLeaderEscalationState,
  cwd = process.cwd()
): Promise<void> {
  await writeJsonFile(resolveTeamLeaderEscalationsPath(teamName, cwd), state);
}

async function writeMonitorPolicyState(
  teamName: string,
  state: AgmoTeamMonitorPolicyState,
  cwd = process.cwd()
): Promise<void> {
  await writeJsonFile(resolveTeamMonitorPolicyPath(teamName, cwd), state);
}

async function readIntegrationState(
  teamName: string,
  cwd = process.cwd()
): Promise<AgmoTeamIntegrationState | null> {
  return await readJsonFile<AgmoTeamIntegrationState>(
    resolveTeamIntegrationsPath(teamName, cwd)
  );
}

async function writeIntegrationState(
  teamName: string,
  state: AgmoTeamIntegrationState,
  cwd = process.cwd()
): Promise<void> {
  await writeJsonFile(resolveTeamIntegrationsPath(teamName, cwd), state);
}

function runGit(
  args: string[],
  cwd: string
): { ok: true; stdout: string } | { ok: false; stderr: string } {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    return { ok: true, stdout };
  } catch (error) {
    const err = error as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };
    const stderr =
      (typeof err.stderr === "string"
        ? err.stderr
        : err.stderr instanceof Buffer
          ? err.stderr.toString("utf-8")
          : "") ||
      (typeof err.stdout === "string"
        ? err.stdout
        : err.stdout instanceof Buffer
          ? err.stdout.toString("utf-8")
          : "") ||
      err.message ||
      "git command failed";
    return { ok: false, stderr: stderr.trim() };
  }
}

function gitOutput(args: string[], cwd: string): string {
  const result = runGit(args, cwd);
  if (!result.ok) {
    throw new Error(result.stderr);
  }
  return result.stdout;
}

function listGitDirtyEntries(
  cwd: string,
  options: {
    includeUntracked?: boolean;
    ignorePaths?: string[];
  } = {}
): string[] {
  const result = runGit(
    [
      "status",
      "--porcelain",
      ...(options.includeUntracked === false ? ["--untracked-files=no"] : [])
    ],
    cwd
  );
  if (!result.ok) {
    return [];
  }

  const ignorePaths = options.ignorePaths ?? [];
  return result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => {
      const pathPart = line.slice(3).trim();
      const normalized = pathPart.includes(" -> ")
        ? pathPart.split(" -> ").at(-1)?.trim() ?? pathPart
        : pathPart;
      return !ignorePaths.some(
        (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`)
      );
    });
}

function isGitWorkspaceClean(
  cwd: string,
  options: {
    includeUntracked?: boolean;
    ignorePaths?: string[];
  } = {}
): boolean {
  return listGitDirtyEntries(cwd, options).length === 0;
}

function listGitConflictedPaths(cwd: string): string[] {
  const result = runGit(["diff", "--name-only", "--diff-filter=U"], cwd);
  if (!result.ok) {
    return [];
  }

  return result.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isGitMergeCommit(commit: string, cwd: string): boolean {
  const parents = gitOutput(["rev-list", "--parents", "-n", "1", commit], cwd)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parents.length > 2;
}

function isCherryPickEmpty(stderr: string): boolean {
  return /previous cherry-pick is now empty|nothing to commit/i.test(stderr);
}

function isGitNothingToCommit(stderr: string): boolean {
  return /nothing to commit|no changes added to commit/i.test(stderr);
}

function resolveIntegrationTargetRef(
  requestedTargetRef: string | undefined,
  currentRef: string,
  baseRef: string
): {
  requested_target_ref: string;
  target_ref: string;
  target_source: AgmoIntegrationTargetSource;
} {
  if (!requestedTargetRef || requestedTargetRef === "@current") {
    return {
      requested_target_ref: requestedTargetRef ?? "@current",
      target_ref: currentRef,
      target_source: "current"
    };
  }

  if (requestedTargetRef === "@base") {
    return {
      requested_target_ref: requestedTargetRef,
      target_ref: baseRef,
      target_source: "base"
    };
  }

  return {
    requested_target_ref: requestedTargetRef,
    target_ref: requestedTargetRef,
    target_source: "explicit"
  };
}

function sortIntegrationCandidates(
  tasks: AgmoTeamTaskRecord[],
  order: AgmoIntegrationBatchOrder
): AgmoTeamTaskRecord[] {
  const sorted = [...tasks];
  sorted.sort((left, right) => {
    if (order === "task-id") {
      return left.id.localeCompare(right.id, undefined, { numeric: true });
    }

    const leftTime = Date.parse(left.updated_at);
    const rightTime = Date.parse(right.updated_at);
    const timeDelta =
      Number.isFinite(leftTime) && Number.isFinite(rightTime) ? leftTime - rightTime : 0;
    if (timeDelta !== 0) {
      return order === "oldest" ? timeDelta : -timeDelta;
    }

    return left.id.localeCompare(right.id, undefined, { numeric: true });
  });
  return sorted;
}

function abortGitIntegrationState(strategy: AgmoIntegrationStrategy, cwd: string): void {
  if (strategy === "cherry-pick") {
    runGit(["cherry-pick", "--abort"], cwd);
    return;
  }

  const aborted = runGit(["merge", "--abort"], cwd);
  if (!aborted.ok) {
    runGit(["reset", "--merge"], cwd);
  }
}

async function writeIntegrationAssistNote(
  teamName: string,
  input: {
    attemptId: string;
    taskId: string;
    workerName: string;
    branchName?: string;
    strategy: AgmoIntegrationStrategy;
    targetRef?: string;
    commits: string[];
    conflictCommit?: string;
    conflictPaths?: string[];
    reason?: string;
  },
  cwd = process.cwd()
): Promise<string> {
  const path = resolveTeamIntegrationAssistPath(teamName, input.attemptId, cwd);
  const markdown = [
    "# Integration Conflict Assist",
    "",
    `- Team: ${teamName}`,
    `- Task: ${input.taskId}`,
    `- Worker: ${input.workerName}`,
    `- Strategy: ${input.strategy}`,
    ...(input.branchName ? [`- Worker branch: ${input.branchName}`] : []),
    ...(input.targetRef ? [`- Target ref: ${input.targetRef}`] : []),
    ...(input.conflictCommit ? [`- Conflict commit: ${input.conflictCommit}`] : []),
    "",
    "## Conflicted paths",
    ...(input.conflictPaths && input.conflictPaths.length > 0
      ? input.conflictPaths.map((entry) => `- ${entry}`)
      : ["- (not detected)"]),
    "",
    "## Candidate commits",
    ...(input.commits.length > 0 ? input.commits.map((entry) => `- ${entry}`) : ["- none"]),
    "",
    "## Suggested next steps",
    `1. Inspect the worker branch: \`git log --oneline ${input.targetRef ?? "HEAD"}..${input.branchName ?? "HEAD"}\``,
    `2. Review the conflicting files: \`git diff ${input.targetRef ?? "HEAD"}...${input.branchName ?? "HEAD"} -- ${input.conflictPaths?.join(" ") || "."}\``,
    "3. Resolve manually, or retry with a different integration strategy if appropriate.",
    input.strategy === "squash"
      ? `4. Retry with: \`agmo team integrate ${teamName} --task ${input.taskId} --strategy cherry-pick\``
      : `4. Retry with: \`agmo team integrate ${teamName} --task ${input.taskId} --strategy squash\``,
    "",
    "## Last error",
    input.reason ? "```text" : "",
    ...(input.reason ? [input.reason] : ["(none)"]),
    input.reason ? "```" : ""
  ]
    .filter(Boolean)
    .join("\n");

  await writeTextFile(path, `${markdown}\n`);
  return path;
}

function buildAutoNudgeMessage(
  teamName: string,
  worker: AgmoWorkerMonitorSnapshot,
  cwd = process.cwd()
): string {
  const issue =
    worker.health === "dead"
      ? "your worker looks dead or non-reporting"
      : "your worker looks stale";
  const taskNote = worker.current_task_id
    ? `Current task id: ${worker.current_task_id}.`
    : "No current task id is recorded.";
  const dispatchNote =
    worker.pending_dispatch_count > 0
      ? `There are ${worker.pending_dispatch_count} pending dispatch notifications waiting for you.`
      : "There are no pending dispatch notifications.";

  return [
    `Leader monitor check for team ${teamName}: ${issue}.`,
    taskNote,
    dispatchNote,
    `Please re-open your inbox now: ${resolveWorkerInboxPath(teamName, worker.worker_name, cwd)}.`,
    "If you are still active, send a short status update or trigger a heartbeat immediately.",
    `Observed health=${worker.health}; reasons=${worker.reasons.join(", ") || "none"}.`
  ].join(" ");
}

function computeClaimAgeMs(
  task: AgmoTeamTaskRecord,
  checkedAtMs: number
): number | null {
  const claimedAtMs = parseTimestampMs(task.claim?.claimed_at);
  if (claimedAtMs === null) {
    return null;
  }

  return Math.max(0, checkedAtMs - claimedAtMs);
}

function chooseReplacementWorker(
  task: AgmoTeamTaskRecord,
  status: AgmoTeamStatusSnapshot,
  snapshot: AgmoTeamMonitorSnapshot,
  options: {
    allowBusyWorkers?: boolean;
    strictRoleMatch?: boolean;
    maxPendingDispatch?: number;
  } = {},
  excludedWorkers: string[] = []
): string | null {
  const excluded = new Set(excludedWorkers);
  const monitorByWorker = new Map(
    snapshot.workers.map((worker) => [worker.worker_name, worker])
  );

  const baseCandidates = status.workers
    .filter((worker) => !excluded.has(worker.identity.name))
    .map((worker) => ({
      identity: worker.identity,
      status: worker.status,
      monitor: monitorByWorker.get(worker.identity.name)
    }))
    .filter(
      (candidate) =>
        candidate.monitor?.health === "healthy" &&
        (options.allowBusyWorkers === true ||
          (!candidate.status.current_task_id &&
            (candidate.status.state === "idle" || candidate.status.state === "done"))) &&
        (typeof options.maxPendingDispatch !== "number" ||
          (candidate.monitor?.pending_dispatch_count ?? 0) <= options.maxPendingDispatch)
    );

  const roleMatchedCandidates =
    options.strictRoleMatch && task.role
      ? baseCandidates.filter((candidate) => candidate.identity.role === task.role)
      : baseCandidates;
  const candidates =
    roleMatchedCandidates.length > 0 ? roleMatchedCandidates : baseCandidates;

  candidates.sort((left, right) => {
    const leftRoleScore = left.identity.role === task.role ? 1 : 0;
    const rightRoleScore = right.identity.role === task.role ? 1 : 0;
    if (leftRoleScore !== rightRoleScore) {
      return rightRoleScore - leftRoleScore;
    }

    const leftStateScore = left.status.state === "idle" ? 1 : 0;
    const rightStateScore = right.status.state === "idle" ? 1 : 0;
    if (leftStateScore !== rightStateScore) {
      return rightStateScore - leftStateScore;
    }

    const leftDispatch = left.monitor?.pending_dispatch_count ?? 0;
    const rightDispatch = right.monitor?.pending_dispatch_count ?? 0;
    if (leftDispatch !== rightDispatch) {
      return leftDispatch - rightDispatch;
    }

    return left.identity.index - right.identity.index;
  });

  return candidates[0]?.identity.name ?? null;
}

function isOpenTask(task: AgmoTeamTaskRecord): boolean {
  return (
    task.status === "pending" ||
    task.status === "in_progress" ||
    task.status === "blocked"
  );
}

function buildWorkerOpenTaskLoad(status: AgmoTeamStatusSnapshot): Map<string, number> {
  const loads = new Map<string, number>();

  for (const worker of status.workers) {
    loads.set(worker.identity.name, 0);
  }

  for (const task of status.tasks) {
    if (!task.owner || !isOpenTask(task)) {
      continue;
    }
    loads.set(task.owner, (loads.get(task.owner) ?? 0) + 1);
  }

  return loads;
}

function chooseRebalanceOwner(
  task: AgmoTeamTaskRecord,
  status: AgmoTeamStatusSnapshot,
  snapshot: AgmoTeamMonitorSnapshot,
  loads: Map<string, number>,
  options: {
    allowBusyWorkers?: boolean;
    strictRoleMatch?: boolean;
    maxOpenPerWorker?: number;
    maxPendingDispatch?: number;
  } = {},
  excludedWorkers: string[] = []
): string | null {
  const excluded = new Set(excludedWorkers);
  const monitorByWorker = new Map(
    snapshot.workers.map((worker) => [worker.worker_name, worker])
  );

  const baseCandidates = status.workers
    .filter((worker) => !excluded.has(worker.identity.name))
    .map((worker) => ({
      identity: worker.identity,
      status: worker.status,
      monitor: monitorByWorker.get(worker.identity.name),
      load: loads.get(worker.identity.name) ?? 0
    }))
    .filter(
      (candidate) =>
        candidate.monitor?.health === "healthy" &&
        candidate.status.state !== "blocked" &&
        (options.allowBusyWorkers === true ||
          candidate.status.state === "idle" ||
          candidate.status.state === "done") &&
        (typeof options.maxOpenPerWorker !== "number" ||
          candidate.load < options.maxOpenPerWorker) &&
        (typeof options.maxPendingDispatch !== "number" ||
          (candidate.monitor?.pending_dispatch_count ?? 0) <= options.maxPendingDispatch)
    );

  const roleMatchedCandidates =
    options.strictRoleMatch && task.role
      ? baseCandidates.filter((candidate) => candidate.identity.role === task.role)
      : baseCandidates;
  const candidates =
    roleMatchedCandidates.length > 0 ? roleMatchedCandidates : baseCandidates;

  candidates.sort((left, right) => {
    if (left.load !== right.load) {
      return left.load - right.load;
    }

    const leftRoleScore = left.identity.role === task.role ? 1 : 0;
    const rightRoleScore = right.identity.role === task.role ? 1 : 0;
    if (leftRoleScore !== rightRoleScore) {
      return rightRoleScore - leftRoleScore;
    }

    const leftStateScore = left.status.state === "idle" || left.status.state === "done" ? 1 : 0;
    const rightStateScore =
      right.status.state === "idle" || right.status.state === "done" ? 1 : 0;
    if (leftStateScore !== rightStateScore) {
      return rightStateScore - leftStateScore;
    }

    const leftDispatch = left.monitor?.pending_dispatch_count ?? 0;
    const rightDispatch = right.monitor?.pending_dispatch_count ?? 0;
    if (leftDispatch !== rightDispatch) {
      return leftDispatch - rightDispatch;
    }

    return left.identity.index - right.identity.index;
  });

  return candidates[0]?.identity.name ?? null;
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) {
    return remSeconds > 0 ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function computeOpenLoadDelta(loads: Map<string, number>): number {
  const values = [...loads.values()];
  if (values.length === 0) {
    return 0;
  }
  return Math.max(...values) - Math.min(...values);
}

const MONITOR_POLICY_PRESETS: Record<
  AgmoMonitorPolicyPreset,
  Omit<AgmoTeamMonitorPolicyState, "updated_at" | "preset">
> = {
  observe: {
    stale_after_ms: 2 * 60 * 1000,
    dead_after_ms: 10 * 60 * 1000,
    auto_nudge: false,
    auto_reclaim: false,
    auto_reassign: false,
    include_stale: false,
    nudge_cooldown_ms: 5 * 60 * 1000,
    reclaim_lease_ms: DEFAULT_TASK_CLAIM_LEASE_MS,
    escalate_leader: false,
    notify_on_stale: false,
    notify_on_dead: true,
    notify_on_claim_risk: true,
    leader_alert_cooldown_ms: 10 * 60 * 1000,
    escalation_repeat_threshold: 2
  },
  conservative: {
    stale_after_ms: 5 * 60 * 1000,
    dead_after_ms: 15 * 60 * 1000,
    auto_nudge: true,
    auto_reclaim: false,
    auto_reassign: false,
    include_stale: false,
    nudge_cooldown_ms: 15 * 60 * 1000,
    reclaim_lease_ms: DEFAULT_TASK_CLAIM_LEASE_MS * 2,
    escalate_leader: true,
    notify_on_stale: false,
    notify_on_dead: true,
    notify_on_claim_risk: true,
    leader_alert_cooldown_ms: 15 * 60 * 1000,
    escalation_repeat_threshold: 2
  },
  balanced: {
    stale_after_ms: 2 * 60 * 1000,
    dead_after_ms: 10 * 60 * 1000,
    auto_nudge: true,
    auto_reclaim: true,
    auto_reassign: true,
    include_stale: false,
    nudge_cooldown_ms: 5 * 60 * 1000,
    reclaim_lease_ms: DEFAULT_TASK_CLAIM_LEASE_MS,
    escalate_leader: true,
    notify_on_stale: true,
    notify_on_dead: true,
    notify_on_claim_risk: true,
    leader_alert_cooldown_ms: 5 * 60 * 1000,
    escalation_repeat_threshold: 2
  },
  aggressive: {
    stale_after_ms: 60 * 1000,
    dead_after_ms: 5 * 60 * 1000,
    auto_nudge: true,
    auto_reclaim: true,
    auto_reassign: true,
    include_stale: true,
    nudge_cooldown_ms: 60 * 1000,
    reclaim_lease_ms: Math.max(Math.floor(DEFAULT_TASK_CLAIM_LEASE_MS / 2), 60 * 1000),
    escalate_leader: true,
    notify_on_stale: true,
    notify_on_dead: true,
    notify_on_claim_risk: true,
    leader_alert_cooldown_ms: 60 * 1000,
    escalation_repeat_threshold: 1
  }
};

export function resolveMonitorPolicy(options: {
  preset?: AgmoMonitorPolicyPreset;
  staleAfterMs?: number;
  deadAfterMs?: number;
  autoNudge?: boolean;
  autoReclaim?: boolean;
  autoReassign?: boolean;
  includeStale?: boolean;
  cooldownMs?: number;
  reclaimLeaseMs?: number;
  escalateLeader?: boolean;
  notifyOnStale?: boolean;
  notifyOnDead?: boolean;
  notifyOnClaimRisk?: boolean;
  leaderAlertCooldownMs?: number;
  escalationRepeatThreshold?: number;
} = {}): AgmoTeamMonitorPolicyState {
  const preset = options.preset ?? "observe";
  const base = MONITOR_POLICY_PRESETS[preset];
  const autoReassign = options.autoReassign ?? base.auto_reassign;
  const autoReclaim = (options.autoReclaim ?? base.auto_reclaim) || autoReassign;
  const staleAfterMs = Math.max(options.staleAfterMs ?? base.stale_after_ms, 1);
  const deadAfterMs = Math.max(options.deadAfterMs ?? base.dead_after_ms, staleAfterMs + 1);

  return {
    updated_at: nowIso(),
    preset,
    stale_after_ms: staleAfterMs,
    dead_after_ms: deadAfterMs,
    auto_nudge: options.autoNudge ?? base.auto_nudge,
    auto_reclaim: autoReclaim,
    auto_reassign: autoReassign,
    include_stale: options.includeStale ?? base.include_stale,
    nudge_cooldown_ms: Math.max(options.cooldownMs ?? base.nudge_cooldown_ms, 0),
    reclaim_lease_ms: Math.max(options.reclaimLeaseMs ?? base.reclaim_lease_ms, 1),
    escalate_leader: options.escalateLeader ?? base.escalate_leader,
    notify_on_stale: options.notifyOnStale ?? base.notify_on_stale,
    notify_on_dead: options.notifyOnDead ?? base.notify_on_dead,
    notify_on_claim_risk: options.notifyOnClaimRisk ?? base.notify_on_claim_risk,
    leader_alert_cooldown_ms: Math.max(
      options.leaderAlertCooldownMs ?? base.leader_alert_cooldown_ms,
      0
    ),
    escalation_repeat_threshold: Math.max(
      options.escalationRepeatThreshold ?? base.escalation_repeat_threshold,
      1
    )
  };
}

function classifyWorkerEscalation(
  worker: AgmoWorkerMonitorSnapshot,
  policy: AgmoTeamMonitorPolicyState
): {
  kind: AgmoLeaderEscalationKind;
  severity: AgmoLeaderEscalationSeverity;
} | null {
  if (worker.health === "dead" && policy.notify_on_dead) {
    return { kind: "dead_worker", severity: "critical" };
  }
  if (worker.claim_at_risk && policy.notify_on_claim_risk) {
    return {
      kind: "claim_at_risk",
      severity: worker.health === "dead" ? "critical" : "warn"
    };
  }
  if (worker.health === "stale" && policy.notify_on_stale) {
    return { kind: "stale_worker", severity: "warn" };
  }
  return null;
}

function buildLeaderEscalationFingerprint(worker: AgmoWorkerMonitorSnapshot): string {
  return JSON.stringify({
    health: worker.health,
    claim_at_risk: worker.claim_at_risk,
    reasons: [...worker.reasons].sort()
  });
}

export async function evaluateLeaderEscalations(
  teamName: string,
  snapshot: AgmoTeamMonitorSnapshot,
  policy: AgmoTeamMonitorPolicyState,
  cwd = process.cwd()
): Promise<{
  team_name: string;
  alerts: Array<
    AgmoLeaderEscalationRecord & {
      status: "emitted" | "cooldown_skipped" | "threshold_pending";
    }
  >;
}> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const existingState =
    (await readLeaderEscalationState(normalizedTeamName, cwd)) ?? {
      updated_at: snapshot.checked_at,
      cooldown_ms: policy.leader_alert_cooldown_ms,
      repeat_threshold: policy.escalation_repeat_threshold,
      by_key: {},
      history: []
    };
  const checkedAtMs = Date.parse(snapshot.checked_at);
  const alerts: Array<
    AgmoLeaderEscalationRecord & {
      status: "emitted" | "cooldown_skipped" | "threshold_pending";
    }
  > = [];

  for (const worker of snapshot.workers) {
    const escalation = classifyWorkerEscalation(worker, policy);
    if (!escalation) {
      continue;
    }

    const key = `${worker.worker_name}:${escalation.kind}`;
    const fingerprint = buildLeaderEscalationFingerprint(worker);
    const previous = existingState.by_key[key];
    const sameSituation = previous?.fingerprint === fingerprint;
    const repeatCount = sameSituation ? (previous?.repeat_count ?? 0) + 1 : 1;
    const firstSeenAt = sameSituation ? previous?.first_seen_at ?? snapshot.checked_at : snapshot.checked_at;
    const previousAlertAtMs = parseTimestampMs(previous?.alert_at) ?? 0;
    const withinCooldown =
      sameSituation &&
      previous?.alert_at &&
      checkedAtMs - previousAlertAtMs >= 0 &&
      checkedAtMs - previousAlertAtMs < policy.leader_alert_cooldown_ms;
    const baseRecord: AgmoLeaderEscalationRecord = {
      alert_id: sameSituation ? previous?.alert_id ?? `alert-${randomUUID()}` : `alert-${randomUUID()}`,
      worker_name: worker.worker_name,
      kind: escalation.kind,
      severity: escalation.severity,
      fingerprint,
      reasons: worker.reasons,
      repeat_count: repeatCount,
      first_seen_at: firstSeenAt,
      last_seen_at: snapshot.checked_at,
      ...(previous?.alert_at ? { alert_at: previous.alert_at } : {}),
      ...(previous?.cooldown_until ? { cooldown_until: previous.cooldown_until } : {})
    };

    if (repeatCount < policy.escalation_repeat_threshold) {
      existingState.by_key[key] = baseRecord;
      alerts.push({ ...baseRecord, status: "threshold_pending" });
      continue;
    }

    if (withinCooldown) {
      existingState.by_key[key] = baseRecord;
      alerts.push({ ...baseRecord, status: "cooldown_skipped" });
      continue;
    }

    const emittedRecord: AgmoLeaderEscalationRecord = {
      ...baseRecord,
      alert_at: snapshot.checked_at,
      cooldown_until: new Date(checkedAtMs + policy.leader_alert_cooldown_ms).toISOString()
    };
    existingState.by_key[key] = emittedRecord;
    existingState.history = [...existingState.history, emittedRecord].slice(-100);
    alerts.push({ ...emittedRecord, status: "emitted" });

    await writeEvent(
      normalizedTeamName,
      {
        timestamp: snapshot.checked_at,
        type: "leader_escalation_alert",
        team_name: normalizedTeamName,
        worker_name: worker.worker_name,
        kind: escalation.kind,
        severity: escalation.severity,
        repeat_count: repeatCount,
        reasons: worker.reasons
      },
      cwd
    );
  }

  existingState.updated_at = snapshot.checked_at;
  existingState.cooldown_ms = policy.leader_alert_cooldown_ms;
  existingState.repeat_threshold = policy.escalation_repeat_threshold;
  await writeLeaderEscalationState(normalizedTeamName, existingState, cwd);

  return {
    team_name: normalizedTeamName,
    alerts
  };
}

async function deliverLeaderAlertToMailbox(
  teamName: string,
  alert: AgmoLeaderEscalationRecord,
  config: AgmoLeaderAlertDeliveryState,
  attemptedAt: string,
  cwd = process.cwd()
): Promise<AgmoLeaderAlertDeliveryAttempt> {
  if (!config.mailbox.enabled) {
    return {
      delivery_id: `delivery-${randomUUID()}`,
      alert_id: alert.alert_id,
      worker_name: alert.worker_name,
      kind: alert.kind,
      severity: alert.severity,
      channel: "mailbox",
      status: "skipped",
      attempted_at: attemptedAt,
      detail: "mailbox delivery is disabled"
    };
  }

  const markdownPath = resolveTeamLeaderAlertMailboxMarkdownPath(teamName, cwd);
  const jsonlPath = resolveTeamLeaderAlertMailboxJsonlPath(teamName, cwd);
  const markdownEntry = [
    `## ${attemptedAt} | ${alert.worker_name} | ${alert.kind} | ${alert.severity}`,
    ``,
    `- alert_id: ${alert.alert_id}`,
    `- repeat_count: ${alert.repeat_count}`,
    `- first_seen_at: ${alert.first_seen_at}`,
    `- last_seen_at: ${alert.last_seen_at}`,
    `- reasons: ${alert.reasons.length > 0 ? alert.reasons.join(", ") : "none"}`,
    ``,
    "```text",
    formatLeaderAlertText(teamName, alert),
    "```",
    ""
  ].join("\n");
  const jsonlEntry = {
    timestamp: attemptedAt,
    team_name: teamName,
    alert
  };

  await Promise.all([
    ensureDir(resolveTeamDir(teamName, cwd)),
    appendFile(markdownPath, `${markdownEntry}\n`, "utf-8"),
    appendFile(jsonlPath, `${JSON.stringify(jsonlEntry)}\n`, "utf-8")
  ]);

  return {
    delivery_id: `delivery-${randomUUID()}`,
    alert_id: alert.alert_id,
    worker_name: alert.worker_name,
    kind: alert.kind,
    severity: alert.severity,
    channel: "mailbox",
    status: "delivered",
    attempted_at: attemptedAt,
    target: markdownPath,
    detail: `mailbox:${markdownPath}`
  };
}

async function deliverLeaderAlertToSlack(
  teamName: string,
  alert: AgmoLeaderEscalationRecord,
  config: AgmoLeaderAlertDeliveryState,
  attemptedAt: string
): Promise<AgmoLeaderAlertDeliveryAttempt> {
  const webhookUrl = config.slack.webhook_url?.trim();
  if (!config.slack.enabled || !webhookUrl) {
    return {
      delivery_id: `delivery-${randomUUID()}`,
      alert_id: alert.alert_id,
      worker_name: alert.worker_name,
      kind: alert.kind,
      severity: alert.severity,
      channel: "slack",
      status: "skipped",
      attempted_at: attemptedAt,
      detail: "slack delivery is disabled or webhook_url is missing"
    };
  }

  const payload: Record<string, unknown> = {
    text: formatLeaderAlertSlackText(teamName, alert)
  };
  if (config.slack.username) {
    payload.username = config.slack.username;
  }
  if (config.slack.icon_emoji) {
    payload.icon_emoji = config.slack.icon_emoji;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const responseText = (await response.text()).trim();

  if (!response.ok) {
    throw new Error(`slack webhook returned ${response.status}: ${responseText || "empty body"}`);
  }

  return {
    delivery_id: `delivery-${randomUUID()}`,
    alert_id: alert.alert_id,
    worker_name: alert.worker_name,
    kind: alert.kind,
    severity: alert.severity,
    channel: "slack",
    status: "delivered",
    attempted_at: attemptedAt,
    target: maskWebhookUrl(webhookUrl),
    detail: responseText || "ok"
  };
}

async function deliverLeaderAlertToEmail(
  teamName: string,
  alert: AgmoLeaderEscalationRecord,
  config: AgmoLeaderAlertDeliveryState,
  attemptedAt: string
): Promise<AgmoLeaderAlertDeliveryAttempt> {
  const recipients = config.email.to;
  const sendmailPath = config.email.sendmail_path?.trim() || DEFAULT_SENDMAIL_PATH;
  if (!config.email.enabled || recipients.length === 0) {
    return {
      delivery_id: `delivery-${randomUUID()}`,
      alert_id: alert.alert_id,
      worker_name: alert.worker_name,
      kind: alert.kind,
      severity: alert.severity,
      channel: "email",
      status: "skipped",
      attempted_at: attemptedAt,
      detail: "email delivery is disabled or recipients are missing"
    };
  }

  execFileSync(sendmailPath, ["-t", "-i"], {
    input: formatLeaderAlertEmailMessage(teamName, alert, config),
    encoding: "utf-8",
    stdio: ["pipe", "ignore", "pipe"]
  });

  return {
    delivery_id: `delivery-${randomUUID()}`,
    alert_id: alert.alert_id,
    worker_name: alert.worker_name,
    kind: alert.kind,
    severity: alert.severity,
    channel: "email",
    status: "delivered",
    attempted_at: attemptedAt,
    target: recipients.join(","),
    detail: `sendmail:${sendmailPath}`
  };
}

export async function deliverLeaderAlerts(
  teamName: string,
  alerts: AgmoLeaderEscalationRecord[],
  cwd = process.cwd()
): Promise<AgmoLeaderAlertDeliveryResult> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const storedConfig = await readLeaderAlertDeliveryConfig(normalizedTeamName, cwd);
  const config = resolveLeaderAlertDeliveryState(storedConfig);
  const attempts: AgmoLeaderAlertDeliveryAttempt[] = [];

  for (const alert of alerts) {
    const attemptedAt = nowIso();
    try {
      attempts.push(
        await deliverLeaderAlertToMailbox(normalizedTeamName, alert, config, attemptedAt, cwd)
      );
    } catch (error) {
      attempts.push({
        delivery_id: `delivery-${randomUUID()}`,
        alert_id: alert.alert_id,
        worker_name: alert.worker_name,
        kind: alert.kind,
        severity: alert.severity,
        channel: "mailbox",
        status: "failed",
        attempted_at: attemptedAt,
        target: resolveTeamLeaderAlertMailboxMarkdownPath(normalizedTeamName, cwd),
        error: summarizeError(error)
      });
    }

    for (const channel of ["slack", "email"] as const satisfies readonly AgmoLeaderAlertDeliveryChannel[]) {
      try {
        attempts.push(
          channel === "slack"
            ? await deliverLeaderAlertToSlack(normalizedTeamName, alert, config, attemptedAt)
            : await deliverLeaderAlertToEmail(normalizedTeamName, alert, config, attemptedAt)
        );
      } catch (error) {
        attempts.push({
          delivery_id: `delivery-${randomUUID()}`,
          alert_id: alert.alert_id,
          worker_name: alert.worker_name,
          kind: alert.kind,
          severity: alert.severity,
          channel,
          status: "failed",
          attempted_at: attemptedAt,
          ...(channel === "slack" && config.slack.webhook_url
            ? { target: maskWebhookUrl(config.slack.webhook_url) }
            : {}),
          ...(channel === "email" && config.email.to.length > 0
            ? { target: config.email.to.join(",") }
            : {}),
          error: summarizeError(error)
        });
      }
    }
  }

  await Promise.all([
    appendLeaderAlertDeliveryAttempts(normalizedTeamName, attempts, cwd),
    ...attempts.map((attempt) =>
      writeEvent(
        normalizedTeamName,
        {
          timestamp: attempt.attempted_at,
          type: "leader_alert_delivery",
          team_name: normalizedTeamName,
          alert_id: attempt.alert_id,
          worker_name: attempt.worker_name,
          channel: attempt.channel,
          status: attempt.status,
          target: attempt.target,
          detail: attempt.detail,
          error: attempt.error
        },
        cwd
      )
    )
  ]);

  return {
    team_name: normalizedTeamName,
    attempts,
    config_path: resolveTeamLeaderAlertDeliveryPath(normalizedTeamName, cwd),
    mailbox_markdown_path: resolveTeamLeaderAlertMailboxMarkdownPath(normalizedTeamName, cwd),
    mailbox_jsonl_path: resolveTeamLeaderAlertMailboxJsonlPath(normalizedTeamName, cwd)
  };
}

export async function showLeaderAlertDeliveryConfig(
  teamName: string,
  cwd = process.cwd()
): Promise<Record<string, unknown>> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const status = await readTeamStatus(normalizedTeamName, cwd);
  if (!status) {
    throw new Error(`team not found: ${normalizedTeamName}`);
  }

  const stored = await readLeaderAlertDeliveryConfig(normalizedTeamName, cwd);
  const effective = resolveLeaderAlertDeliveryState(stored);
  const log = await readLeaderAlertDeliveryLog(normalizedTeamName, cwd);

  return {
    team_name: normalizedTeamName,
    config_path: resolveTeamLeaderAlertDeliveryPath(normalizedTeamName, cwd),
    delivery_log_path: resolveTeamLeaderAlertDeliveryLogPath(normalizedTeamName, cwd),
    mailbox_markdown_path: resolveTeamLeaderAlertMailboxMarkdownPath(normalizedTeamName, cwd),
    mailbox_jsonl_path: resolveTeamLeaderAlertMailboxJsonlPath(normalizedTeamName, cwd),
    configured: stored ? redactLeaderAlertDeliveryState(stored) : null,
    effective: redactLeaderAlertDeliveryState(effective),
    recent_attempts: (log?.attempts ?? []).slice(-10)
  };
}

export async function configureLeaderAlertDelivery(
  teamName: string,
  updates: {
    mailboxEnabled?: boolean;
    slackEnabled?: boolean;
    slackWebhookUrl?: string;
    slackUsername?: string;
    slackIconEmoji?: string;
    emailEnabled?: boolean;
    emailTo?: string[];
    emailFrom?: string;
    emailSendmailPath?: string;
    emailSubjectPrefix?: string;
  },
  cwd = process.cwd()
): Promise<Record<string, unknown>> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const status = await readTeamStatus(normalizedTeamName, cwd);
  if (!status) {
    throw new Error(`team not found: ${normalizedTeamName}`);
  }

  const current = resolveLeaderAlertDeliveryState(
    await readLeaderAlertDeliveryConfig(normalizedTeamName, cwd)
  );
  const next: AgmoLeaderAlertDeliveryState = {
    updated_at: nowIso(),
    mailbox: {
      enabled: updates.mailboxEnabled ?? current.mailbox.enabled
    },
    slack: {
      enabled:
        updates.slackEnabled ??
        (updates.slackWebhookUrl ? true : current.slack.enabled),
      ...(updates.slackWebhookUrl !== undefined
        ? updates.slackWebhookUrl.trim()
          ? { webhook_url: updates.slackWebhookUrl.trim() }
          : {}
        : current.slack.webhook_url
          ? { webhook_url: current.slack.webhook_url }
          : {}),
      ...(updates.slackUsername !== undefined
        ? updates.slackUsername.trim()
          ? { username: updates.slackUsername.trim() }
          : {}
        : current.slack.username
          ? { username: current.slack.username }
          : {}),
      ...(updates.slackIconEmoji !== undefined
        ? updates.slackIconEmoji.trim()
          ? { icon_emoji: updates.slackIconEmoji.trim() }
          : {}
        : current.slack.icon_emoji
          ? { icon_emoji: current.slack.icon_emoji }
          : {})
    },
    email: {
      enabled:
        updates.emailEnabled ??
        ((updates.emailTo?.length ?? 0) > 0 ? true : current.email.enabled),
      to: updates.emailTo ?? current.email.to,
      ...((updates.emailFrom !== undefined
        ? updates.emailFrom.trim()
        : current.email.from)?.trim()
        ? {
            from:
              updates.emailFrom !== undefined
                ? updates.emailFrom.trim()
                : current.email.from?.trim()
          }
        : {}),
      ...((updates.emailSendmailPath !== undefined
        ? updates.emailSendmailPath.trim()
        : current.email.sendmail_path)?.trim()
        ? {
            sendmail_path:
              updates.emailSendmailPath !== undefined
                ? updates.emailSendmailPath.trim()
                : current.email.sendmail_path?.trim()
          }
        : {}),
      ...((updates.emailSubjectPrefix !== undefined
        ? updates.emailSubjectPrefix.trim()
        : current.email.subject_prefix)?.trim()
        ? {
            subject_prefix:
              updates.emailSubjectPrefix !== undefined
                ? updates.emailSubjectPrefix.trim()
                : current.email.subject_prefix?.trim()
          }
        : {})
    }
  };

  await Promise.all([
    writeLeaderAlertDeliveryConfig(normalizedTeamName, next, cwd),
    writeEvent(
      normalizedTeamName,
      {
        timestamp: next.updated_at,
        type: "leader_alert_delivery_configured",
        team_name: normalizedTeamName,
        mailbox_enabled: next.mailbox.enabled,
        slack_enabled: next.slack.enabled,
        slack_webhook_configured: Boolean(next.slack.webhook_url),
        email_enabled: next.email.enabled,
        email_recipient_count: next.email.to.length
      },
      cwd
    )
  ]);

  return {
    team_name: normalizedTeamName,
    config_path: resolveTeamLeaderAlertDeliveryPath(normalizedTeamName, cwd),
    effective: redactLeaderAlertDeliveryState(next)
  };
}

export async function buildLeaderMonitorView(
  teamName: string,
  snapshot: AgmoTeamMonitorSnapshot,
  options: {
    policy?: AgmoTeamMonitorPolicyState;
    leaderAlerts?: Array<{
      worker_name: string;
      kind: AgmoLeaderEscalationKind;
      severity: AgmoLeaderEscalationSeverity;
      status: "emitted" | "cooldown_skipped" | "threshold_pending";
    }>;
    autoNudges?: Array<{ worker_name: string; status: "sent" | "cooldown_skipped" }>;
    autoRecovery?: Array<{
      task_id: string;
      reassigned: boolean;
      previous_owner: string;
      next_owner?: string;
    }>;
    leaderAlertDelivery?: AgmoLeaderAlertDeliveryAttempt[];
  } = {},
  cwd = process.cwd()
): Promise<{
  team_name: string;
  path: string;
  markdown: string;
}> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const status = await readTeamStatus(normalizedTeamName, cwd);
  if (!status) {
    throw new Error(`team not found: ${normalizedTeamName}`);
  }

  const taskCounts = {
    pending: status.tasks.filter((task) => task.status === "pending").length,
    in_progress: status.tasks.filter((task) => task.status === "in_progress").length,
    blocked: status.tasks.filter((task) => task.status === "blocked").length,
    completed: status.tasks.filter((task) => task.status === "completed").length,
    failed: status.tasks.filter((task) => task.status === "failed").length
  };
  const pendingDispatch = status.dispatch_requests.filter(
    (request) => request.status === "pending" || request.status === "notified"
  ).length;
  const openLoads = buildWorkerOpenTaskLoad(status);
  const openLoadDelta = computeOpenLoadDelta(openLoads);
  const monitorByWorker = new Map(snapshot.workers.map((worker) => [worker.worker_name, worker]));
  const actions: string[] = [];

  if (snapshot.dead_workers > 0 || snapshot.stale_workers > 0) {
    actions.push(`Run \`agmo team monitor ${normalizedTeamName} --auto-nudge\` to nudge non-reporting workers.`);
  }
  if (snapshot.workers.some((worker) => worker.claim_at_risk)) {
    actions.push(`Run \`agmo team reclaim ${normalizedTeamName} --reassign\` to recover risky claims.`);
  }
  if (openLoadDelta > 1) {
    actions.push(`Run \`agmo team rebalance ${normalizedTeamName}\` to smooth pending-task ownership.`);
  }
  if (pendingDispatch > 0) {
    actions.push(`Run \`agmo team dispatch-retry ${normalizedTeamName}\` to retry pending notifications.`);
  }
  if (actions.length === 0) {
    actions.push("No immediate operator action recommended.");
  }

  const workerLines = snapshot.workers
    .map((worker) => {
      const openLoad = openLoads.get(worker.worker_name) ?? 0;
      const taskLabel = worker.current_task_id ? ` task=${worker.current_task_id}` : "";
      const dispatchLabel =
        worker.pending_dispatch_count > 0 ? ` dispatch=${worker.pending_dispatch_count}` : "";
      const riskLabel = worker.claim_at_risk ? " claim-risk" : "";
      const reasonLabel =
        worker.reasons.length > 0 ? ` reasons=${worker.reasons.join(",")}` : "";
      return `- ${worker.worker_name} | ${worker.health}/${worker.status_state} | open=${openLoad} | hb=${formatDurationMs(worker.ms_since_heartbeat)}${taskLabel}${dispatchLabel}${riskLabel}${reasonLabel}`;
    })
    .join("\n");

  const taskLines = status.tasks
    .filter((task) => task.status === "pending" || task.status === "in_progress" || task.status === "blocked")
    .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
    .map((task) => {
      const ownerHealth = task.owner ? monitorByWorker.get(task.owner)?.health : undefined;
      const claimAge = task.claim ? computeClaimAgeMs(task, Date.parse(snapshot.checked_at)) : null;
      const claimLabel =
        claimAge !== null ? ` claim_age=${formatDurationMs(claimAge)}` : "";
      const ownerLabel = task.owner ? `${task.owner}${ownerHealth ? `/${ownerHealth}` : ""}` : "unassigned";
      return `- task ${task.id} | ${task.status} | owner=${ownerLabel}${claimLabel} | ${task.subject}`;
    })
    .join("\n");

  const nudgeSummary =
    options.autoNudges && options.autoNudges.length > 0
      ? `- auto_nudges: ${options.autoNudges.map((entry) => `${entry.worker_name}:${entry.status}`).join(", ")}`
      : "- auto_nudges: none";
  const recoverySummary =
    options.autoRecovery && options.autoRecovery.length > 0
      ? `- auto_reclaim: ${options.autoRecovery.map((entry) => `${entry.task_id}:${entry.previous_owner}->${entry.next_owner ?? "unassigned"}`).join(", ")}`
      : "- auto_reclaim: none";
  const policySummary = options.policy
    ? [
        `- preset: ${options.policy.preset}`,
        `- stale_after_ms: ${options.policy.stale_after_ms}`,
        `- dead_after_ms: ${options.policy.dead_after_ms}`,
        `- auto_nudge: ${options.policy.auto_nudge}`,
        `- auto_reclaim: ${options.policy.auto_reclaim}`,
        `- auto_reassign: ${options.policy.auto_reassign}`,
        `- include_stale: ${options.policy.include_stale}`,
        `- nudge_cooldown_ms: ${options.policy.nudge_cooldown_ms}`,
        `- reclaim_lease_ms: ${options.policy.reclaim_lease_ms}`,
        `- escalate_leader: ${options.policy.escalate_leader}`,
        `- notify_on_stale: ${options.policy.notify_on_stale}`,
        `- notify_on_dead: ${options.policy.notify_on_dead}`,
        `- notify_on_claim_risk: ${options.policy.notify_on_claim_risk}`,
        `- leader_alert_cooldown_ms: ${options.policy.leader_alert_cooldown_ms}`,
        `- escalation_repeat_threshold: ${options.policy.escalation_repeat_threshold}`
      ]
    : [];
  const alertSummary =
    options.leaderAlerts && options.leaderAlerts.length > 0
      ? `- leader_alerts: ${options.leaderAlerts
          .map((entry) => `${entry.worker_name}:${entry.kind}:${entry.status}`)
          .join(", ")}`
      : "- leader_alerts: none";
  const alertDeliverySummary =
    options.leaderAlertDelivery && options.leaderAlertDelivery.length > 0
      ? `- leader_alert_delivery: ${options.leaderAlertDelivery
          .map((entry) => `${entry.channel}:${entry.status}`)
          .join(", ")}`
      : "- leader_alert_delivery: none";

  const markdown = [
    `# Leader Monitor View`,
    ``,
    `Team: ${normalizedTeamName}`,
    `Checked at: ${snapshot.checked_at}`,
    ``,
    `## Summary`,
    `- workers: healthy=${snapshot.healthy_workers}, stale=${snapshot.stale_workers}, dead=${snapshot.dead_workers}, active=${snapshot.active_workers}`,
    `- tasks: pending=${taskCounts.pending}, in_progress=${taskCounts.in_progress}, blocked=${taskCounts.blocked}, completed=${taskCounts.completed}, failed=${taskCounts.failed}`,
    `- pending_dispatch_requests: ${pendingDispatch}`,
    `- open_load_delta: ${openLoadDelta}`,
    nudgeSummary,
    recoverySummary,
    alertSummary,
    alertDeliverySummary,
    ``,
    ...(policySummary.length > 0 ? [`## Applied policy`, ...policySummary, ``] : []),
    `## Recommended actions`,
    ...actions.map((action) => `- ${action}`),
    ``,
    `## Workers`,
    workerLines || "- none",
    ``,
    `## Open tasks`,
    taskLines || "- none"
  ].join("\n");

  const path = resolveTeamLeaderMonitorViewPath(normalizedTeamName, cwd);
  await writeTextFile(path, `${markdown}\n`);

  return {
    team_name: normalizedTeamName,
    path,
    markdown
  };
}

export async function buildLeaderHudView(
  teamName: string,
  options: {
    staleAfterMs?: number;
    deadAfterMs?: number;
  } = {},
  cwd = process.cwd()
): Promise<{
  team_name: string;
  path: string;
  text: string;
}> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const snapshot = await monitorTeamRuntime(
    normalizedTeamName,
    {
      staleAfterMs: options.staleAfterMs,
      deadAfterMs: options.deadAfterMs
    },
    cwd
  );
  const status = await readTeamStatus(normalizedTeamName, cwd);
  if (!status) {
    throw new Error(`team not found: ${normalizedTeamName}`);
  }

  const taskCounts = {
    pending: status.tasks.filter((task) => task.status === "pending").length,
    in_progress: status.tasks.filter((task) => task.status === "in_progress").length,
    blocked: status.tasks.filter((task) => task.status === "blocked").length,
    completed: status.tasks.filter((task) => task.status === "completed").length,
    failed: status.tasks.filter((task) => task.status === "failed").length
  };
  const openLoads = buildWorkerOpenTaskLoad(status);
  const openLoadDelta = computeOpenLoadDelta(openLoads);
  const pendingDispatch = status.dispatch_requests.filter(
    (request) => request.status === "pending" || request.status === "notified"
  ).length;
  const activeLeaderAlerts = Object.values(status.leader_escalations?.by_key ?? {}).filter(
    (entry) => Boolean(entry.alert_at)
  ).length;
  const topActions: string[] = [];

  if (snapshot.dead_workers > 0 || snapshot.stale_workers > 0) {
    topActions.push("nudge");
  }
  if (snapshot.workers.some((worker) => worker.claim_at_risk)) {
    topActions.push("reclaim");
  }
  if (openLoadDelta > 1) {
    topActions.push("rebalance");
  }
  if (pendingDispatch > 0) {
    topActions.push("retry-dispatch");
  }
  if (activeLeaderAlerts > 0) {
    topActions.push("alert");
  }

  const workerLines = snapshot.workers
    .map((worker) => {
      const load = openLoads.get(worker.worker_name) ?? 0;
      const currentTask = worker.current_task_id ? ` t=${worker.current_task_id}` : "";
      const dispatch = worker.pending_dispatch_count > 0 ? ` d=${worker.pending_dispatch_count}` : "";
      const risk = worker.claim_at_risk ? " !" : "";
      return `${worker.worker_name.padEnd(8)} ${worker.health.padEnd(7)} ${worker.status_state.padEnd(7)} open=${String(load).padEnd(2)} hb=${formatDurationMs(worker.ms_since_heartbeat).padEnd(6)}${currentTask}${dispatch}${risk}`;
    })
    .join("\n");

  const text = [
    `AGMO HUD | team=${normalizedTeamName} | checked=${snapshot.checked_at}`,
    `workers h=${snapshot.healthy_workers} s=${snapshot.stale_workers} d=${snapshot.dead_workers} active=${snapshot.active_workers} | tasks p=${taskCounts.pending} w=${taskCounts.in_progress} b=${taskCounts.blocked} c=${taskCounts.completed} f=${taskCounts.failed} | alerts=${activeLeaderAlerts}`,
    `dispatch_pending=${pendingDispatch} | open_load_delta=${openLoadDelta} | actions=${topActions.length > 0 ? topActions.join(",") : "none"}`,
    "",
    workerLines || "no workers"
  ].join("\n");

  const path = resolveTeamLeaderHudPath(normalizedTeamName, cwd);
  await writeTextFile(path, `${text}\n`);

  return {
    team_name: normalizedTeamName,
    path,
    text
  };
}

function buildTaskRecords(
  teamName: string,
  task: string,
  workerNames: string[],
  options: {
    intentOverride?: AgmoTaskIntent;
    roleOverrides?: Record<string, string>;
  } = {}
): AgmoTeamTaskRecord[] {
  const roleOverridesByIndex = Object.fromEntries(
    workerNames.flatMap((workerName, index) => {
      const role = options.roleOverrides?.[workerName];
      return role ? [[index + 1, role]] : [];
    })
  );
  const allocation = buildInitialTaskLanesWithOverrides(task, workerNames.length, {
    intentOverride: options.intentOverride,
    roleOverridesByIndex
  });
  const timestamp = nowIso();

  return workerNames.map((workerName, index) => {
    const lane = allocation.lanes[index] ?? allocation.lanes[allocation.lanes.length - 1];
    const laneLabel = `${lane.lane} lane`;
    const blockers = lane.dependsOn.map((dependencyId) => ({
      task_id: String(dependencyId),
      status: "pending" as const,
      reason: "dependency_not_completed" as const
    }));
    return {
      id: String(index + 1),
      subject: `${task} [${laneLabel} ${index + 1}/${workerNames.length}]`,
      description: [
        `Assigned worker slice for team ${teamName}: ${task}`,
        `Intent: ${allocation.routing.intent}.`,
        `Lane summary: ${lane.summary}`,
        `Routing reason: ${allocation.routing.reason}`,
        ...(lane.overrideReason ? [`Override: ${lane.overrideReason}`] : [])
      ].join(" "),
      owner: workerName,
      role: lane.role,
      status: blockers.length > 0 ? "blocked" : "pending",
      depends_on: lane.dependsOn.map(String),
      blocked_by_dependencies: blockers.length > 0 ? blockers : undefined,
      requires_code_change: lane.requiresCodeChange,
      assignment_history: [
        {
          owner: workerName,
          assigned_at: timestamp,
          reason: lane.overrideReason
            ? `initial_role_allocation:${lane.lane}:override`
            : `initial_role_allocation:${lane.lane}`
        }
      ],
      version: 1,
      created_at: timestamp,
      updated_at: timestamp
    };
  });
}

async function writeEvent(
  teamName: string,
  event: Record<string, unknown>,
  cwd = process.cwd()
): Promise<void> {
  const path = resolveTeamEventsPath(teamName, cwd);
  await ensureDir(resolveTeamDir(teamName, cwd));
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf-8");
}

async function ensureTeamStateDirs(teamName: string, workerNames: string[], cwd = process.cwd()): Promise<void> {
  await Promise.all([
    ensureDir(resolveTeamDir(teamName, cwd)),
    ensureDir(resolveTeamTasksDir(teamName, cwd)),
    ensureDir(resolveTeamMailboxDir(teamName, cwd)),
    ensureDir(join(resolveTeamDir(teamName, cwd), "dispatch")),
    ...workerNames.map((workerName) => ensureDir(resolveWorkerDir(teamName, workerName, cwd)))
  ]);
}

async function listTeamNames(cwd = process.cwd()): Promise<string[]> {
  try {
    const entries = await readdir(resolveTeamStateRoot(cwd), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export async function startTeamRuntime(
  request: TeamStartRequest,
  cwd = process.cwd()
): Promise<Record<string, unknown>> {
  assertValidWorkerCount(request.workerCount);

  const teamName = sanitizeTeamName(request.teamName ?? generateTeamName(request.task));
  const existingConfig = await readJsonFile<AgmoTeamConfig>(
    resolveTeamConfigPath(teamName, cwd)
  );

  if (existingConfig?.active) {
    throw new Error(`team already active: ${teamName}`);
  }

  const workerNames = buildWorkerNames(request.workerCount);
  const tmux = describeTmuxSessionTopology(request.workerCount);
  const timestamp = nowIso();
  const stateRoot = resolveTeamStateRoot(cwd);
  const sessionId = resolveTeamSessionId(request.sessionId);

  await ensureTeamStateDirs(teamName, workerNames, cwd);

  const config: AgmoTeamConfig = {
    name: teamName,
    created_at: timestamp,
    updated_at: timestamp,
    session_id: sessionId,
    active: true,
    phase: "active",
    task: request.task,
    worker_count: request.workerCount,
    worker_names: workerNames,
    transport: "none",
    tmux: {
      available: tmux.available,
      in_tmux_client: tmux.in_tmux_client,
      leader_pane_id: tmux.leader_pane_id,
      hud_pane_id: null,
      hud_refresh_ms: request.hud ? Math.max(request.hudRefreshMs ?? 2000, 250) : null,
      hud_clear_screen: request.hudClearScreen ?? true,
      worker_pane_ids: {}
    },
    workspace: {
      strategy: "worktree-per-worker",
      root: join(cwd, ".agmo", "worktrees", teamName)
    },
    ...(request.allocationIntent || request.roleOverrides
      ? {
          initial_allocation: {
            ...(request.allocationIntent ? { intent: request.allocationIntent } : {}),
            ...(request.roleOverrides ? { role_map: request.roleOverrides } : {})
          }
        }
      : {})
  };

  const manifest: AgmoTeamManifest = {
    version: 1,
    team_name: teamName,
    created_at: timestamp,
    session_id: sessionId,
    task: request.task,
    worker_count: request.workerCount,
    worker_names: workerNames
  };

  const phase: AgmoTeamPhaseState = {
    current_phase: "active",
    updated_at: timestamp,
    active: true
  };

  const tasks = buildTaskRecords(teamName, request.task, workerNames, {
    intentOverride: request.allocationIntent,
    roleOverrides: request.roleOverrides
  });

  await Promise.all([
    writeJsonFile(resolveTeamConfigPath(teamName, cwd), config),
    writeJsonFile(resolveTeamManifestPath(teamName, cwd), manifest),
    writeJsonFile(resolveTeamPhasePath(teamName, cwd), phase),
    writeJsonFile(resolveTeamDispatchPath(teamName, cwd), [])
  ]);

  await Promise.all(
    tasks.map((taskRecord) =>
      writeJsonFile(resolveTeamTaskPath(teamName, taskRecord.id, cwd), taskRecord)
    )
  );

  const workerRuntimeSpecs = await Promise.all(
    workerNames.map(async (workerName, index) => {
      const role = tasks[index]?.role ?? "agmo-executor";
      const worktree = await provisionWorkerWorktree(teamName, workerName, cwd);
      const worktreePath = worktree.path;
      const cliEntryPath = agmoCliDistEntryPath();
      const workerHooksFile = join(worktreePath, ".codex", "hooks.json");
      const workerHookCommand = buildHookCommand(cliEntryPath);
      const identity: AgmoWorkerIdentity = {
        name: workerName,
        role,
        index: index + 1,
        working_dir: worktreePath,
        worktree_path: worktreePath,
        team_state_root: stateRoot,
        git_branch: worktree.branch_name
      };

      const inbox = buildInitialWorkerInbox({
        workerName,
        teamName,
        role,
        taskSummary: tasks[index]?.subject ?? request.task,
        teamStateRoot: stateRoot,
        worktreePath,
        cliEntryPath
      });
      const instructions = buildWorkerInstructions({
        workerName,
        teamName,
        role,
        teamStateRoot: stateRoot,
        inboxPath: resolveWorkerInboxPath(teamName, workerName, cwd),
        worktreePath,
        cliEntryPath
      });

      const mailbox: AgmoMailboxMessage[] = [
        {
          message_id: createMessageId(),
          from_worker: "leader-fixed",
          to_worker: workerName,
          body: `Team ${teamName} started. Begin with assigned task: ${tasks[index]?.subject ?? request.task}`,
          created_at: timestamp
        }
      ];

      await Promise.all([
        writeJsonFile(resolveWorkerIdentityPath(teamName, workerName, cwd), identity),
        writeJsonFile(resolveWorkerStatusPath(teamName, workerName, cwd), buildDefaultWorkerStatus()),
        writeJsonFile(resolveWorkerHeartbeatPath(teamName, workerName, cwd), buildDefaultWorkerHeartbeat()),
        writeTextFile(resolveWorkerInboxPath(teamName, workerName, cwd), inbox),
        writeTextFile(resolveWorkerInstructionsPath(teamName, workerName, cwd), instructions),
        writeTextFile(join(worktreePath, "AGENTS.md"), instructions),
        writeJsonFile(resolveWorkerMailboxPath(teamName, workerName, cwd), mailbox),
        writeTextFile(
          workerHooksFile,
          mergeManagedHooksConfig(null, workerHookCommand)
        )
      ]);

      return {
        teamName,
        workerName,
        projectRoot: cwd,
        role,
        worktreePath,
        worktree,
        inboxPath: resolveWorkerInboxPath(teamName, workerName, cwd),
        instructionsPath: join(worktreePath, "AGENTS.md"),
        taskSummary: tasks[index]?.subject ?? request.task
      };
    })
  );

  const primaryGitWorktree = workerRuntimeSpecs.find((spec) => spec.worktree.git_enabled)?.worktree;
  if (primaryGitWorktree) {
    config.workspace = {
      strategy: "git-worktree-per-worker",
      root: join(cwd, ".agmo", "worktrees", teamName),
      git: {
        enabled: true,
        repo_root: primaryGitWorktree.repo_root,
        base_ref: primaryGitWorktree.base_ref
      }
    };
  }

  if (shouldSpawnTeamTmuxPanes(request, tmux)) {
    const createdSession = createTeamSession(
      workerRuntimeSpecs.map((spec) => ({
        teamName: spec.teamName,
        workerName: spec.workerName,
        projectRoot: spec.projectRoot,
        workingDir: spec.worktreePath,
        inboxPath: spec.inboxPath,
        role: spec.role,
        instructionsPath: spec.instructionsPath,
        taskSummary: spec.taskSummary
      })),
      request.hud
        ? {
            hud: {
              teamName,
              projectRoot: cwd,
              cliEntryPath: agmoCliDistEntryPath(),
              refreshMs: Math.max(request.hudRefreshMs ?? 2000, 250),
              clearScreen: request.hudClearScreen ?? true
            }
          }
        : {}
    );

    config.transport = "tmux";
    config.tmux.leader_pane_id = createdSession.leaderPaneId;
    config.tmux.hud_pane_id = createdSession.hudPaneId ?? null;
    config.tmux.worker_pane_ids = createdSession.workerPaneIds;

    await Promise.all(
      workerRuntimeSpecs.map(async (spec, index) => {
        const workerName = spec.workerName;
        const identity: AgmoWorkerIdentity = {
          name: workerName,
          role: spec.role,
          index: index + 1,
          working_dir: spec.worktreePath,
          worktree_path: spec.worktreePath,
          team_state_root: stateRoot,
          pane_id: createdSession.workerPaneIds[workerName],
          git_branch: spec.worktree.branch_name
        };

        await writeJsonFile(
          resolveWorkerIdentityPath(teamName, workerName, cwd),
          identity
        );
      })
    );
  }

  await writeJsonFile(resolveTeamConfigPath(teamName, cwd), config);

  await writeEvent(
    teamName,
    {
      timestamp,
      type: "team_started",
      team_name: teamName,
      worker_count: request.workerCount,
      transport: config.transport,
      tmux_worker_pane_count: Object.keys(config.tmux.worker_pane_ids).length,
      ...(request.allocationIntent ? { allocation_intent: request.allocationIntent } : {}),
      ...(request.roleOverrides ? { allocation_role_map: request.roleOverrides } : {}),
      initial_roles: tasks.map((taskRecord) => ({
        task_id: taskRecord.id,
        owner: taskRecord.owner,
        role: taskRecord.role,
        requires_code_change: taskRecord.requires_code_change
      }))
    },
    cwd
  );

  return {
    team_name: teamName,
    config,
    manifest,
    phase,
    tasks_created: tasks.length,
    ...(request.allocationIntent ? { allocation_intent: request.allocationIntent } : {}),
    ...(request.roleOverrides ? { allocation_role_map: request.roleOverrides } : {}),
    initial_roles: tasks.map((taskRecord) => ({
      task_id: taskRecord.id,
      owner: taskRecord.owner,
      role: taskRecord.role,
      subject: taskRecord.subject,
      depends_on: taskRecord.depends_on ?? [],
      requires_code_change: taskRecord.requires_code_change ?? true
    })),
    tmux
  };
}

export async function readTeamStatus(
  teamName: string,
  cwd = process.cwd()
): Promise<AgmoTeamStatusSnapshot | null> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const config = await readJsonFile<AgmoTeamConfig>(
    resolveTeamConfigPath(normalizedTeamName, cwd)
  );

  if (!config) {
    return null;
  }

  const manifest = await readJsonFile<AgmoTeamManifest>(
    resolveTeamManifestPath(normalizedTeamName, cwd)
  );
  const phase = await readJsonFile<AgmoTeamPhaseState>(
    resolveTeamPhasePath(normalizedTeamName, cwd)
  );
  const dispatchRequests =
    (await readJsonFile<AgmoDispatchRequest[]>(
      resolveTeamDispatchPath(normalizedTeamName, cwd)
    )) ?? [];
  const leaderNudges = await readLeaderNudgeState(normalizedTeamName, cwd);
  const leaderEscalations = await readLeaderEscalationState(normalizedTeamName, cwd);
  const leaderAlertDelivery = await readLeaderAlertDeliveryConfig(normalizedTeamName, cwd);
  const integrations = await readIntegrationState(normalizedTeamName, cwd);

  const tasks = await Promise.all(
    config.worker_names.map(async (_, index) => {
      return await readJsonFile<AgmoTeamTaskRecord>(
        resolveTeamTaskPath(normalizedTeamName, String(index + 1), cwd)
      );
    })
  );

  const workers = await Promise.all(
    config.worker_names.map(async (workerName) => {
      const [identity, status, heartbeat] = await Promise.all([
        readJsonFile<AgmoWorkerIdentity>(
          resolveWorkerIdentityPath(normalizedTeamName, workerName, cwd)
        ),
        readJsonFile<AgmoWorkerStatus>(
          resolveWorkerStatusPath(normalizedTeamName, workerName, cwd)
        ),
        readJsonFile<AgmoWorkerHeartbeat>(
          resolveWorkerHeartbeatPath(normalizedTeamName, workerName, cwd)
        )
      ]);

      if (!identity || !status || !heartbeat) {
        throw new Error(`worker state incomplete for ${workerName}`);
      }

      return {
        identity,
        status,
        heartbeat,
        inbox_path: resolveWorkerInboxPath(normalizedTeamName, workerName, cwd),
        mailbox_path: resolveWorkerMailboxPath(normalizedTeamName, workerName, cwd)
      };
    })
  );

  const mailbox = Object.fromEntries(
    await Promise.all(
      config.worker_names.map(async (workerName) => {
        const entries =
          (await readJsonFile<AgmoMailboxMessage[]>(
            resolveWorkerMailboxPath(normalizedTeamName, workerName, cwd)
          )) ?? [];

        return [workerName, entries];
      })
    )
  );

  if (!manifest || !phase) {
    throw new Error(`team state incomplete for ${normalizedTeamName}`);
  }

  return {
    config,
    manifest,
    phase,
    tasks: tasks.filter((entry): entry is AgmoTeamTaskRecord => entry !== null),
    workers,
    mailbox,
    dispatch_requests: dispatchRequests,
    leader_alert_delivery: leaderAlertDelivery,
    leader_escalations: leaderEscalations,
    leader_nudges: leaderNudges,
    integrations
  };
}

export async function shutdownTeamRuntime(
  teamName: string,
  cwd = process.cwd()
): Promise<Record<string, unknown>> {
  const status = await readTeamStatus(teamName, cwd);

  if (!status) {
    throw new Error(`team not found: ${teamName}`);
  }

  const timestamp = nowIso();
  const nextConfig: AgmoTeamConfig = {
    ...status.config,
    active: false,
    phase: "shutdown",
    updated_at: timestamp
  };
  const nextPhase: AgmoTeamPhaseState = {
    current_phase: "shutdown",
    updated_at: timestamp,
    active: false
  };
  const nextTasks = status.tasks.map((task) => buildShutdownTaskRecord(task, timestamp));
  const nextDispatchRequests = status.dispatch_requests.map((request) =>
    request.status === "delivered" || request.status === "failed"
      ? request
      : {
          ...request,
          status: "failed" as const,
          failed_at: timestamp
        }
  );

  await Promise.all([
    writeJsonFile(resolveTeamConfigPath(status.config.name, cwd), nextConfig),
    writeJsonFile(resolveTeamPhasePath(status.config.name, cwd), nextPhase),
    writeDispatchRequests(status.config.name, nextDispatchRequests, cwd),
    ...nextTasks.map((task) => writeTaskRecord(status.config.name, task, cwd)),
    ...status.workers.flatMap((worker) => [
      writeWorkerStatus(
        status.config.name,
        worker.identity.name,
        buildShutdownWorkerStatus(timestamp),
        cwd
      ),
      writeWorkerHeartbeat(
        status.config.name,
        worker.identity.name,
        buildShutdownWorkerHeartbeat(worker.heartbeat, timestamp),
        cwd
      )
    ])
  ]);

  if (status.config.transport === "tmux") {
    destroyWorkerPanes(
      [
        ...Object.values(status.config.tmux.worker_pane_ids),
        ...(status.config.tmux.hud_pane_id ? [status.config.tmux.hud_pane_id] : [])
      ]
    );
  }

  await writeEvent(
    status.config.name,
    {
      timestamp,
      type: "team_shutdown",
      team_name: status.config.name
    },
    cwd
  );

  return {
    team_name: status.config.name,
    previous_phase: status.phase.current_phase,
    current_phase: nextPhase.current_phase,
    tasks_failed: nextTasks.filter((task) => task.status === "failed").length,
    dispatch_requests_failed: nextDispatchRequests.filter((request) => request.status === "failed")
      .length,
    preserved_state_root: resolveTeamDir(status.config.name, cwd)
  };
}

export async function cleanupStaleTeamRuntimes(
  options: {
    staleAfterMs?: number;
    deadAfterMs?: number;
    includeStale?: boolean;
    dryRun?: boolean;
  } = {},
  cwd = process.cwd()
): Promise<{
  checked_at: string;
  team_count: number;
  active_team_count: number;
  cleaned: Array<{
    team_name: string;
    reason: "all_workers_dead" | "no_healthy_workers";
    healthy_workers: number;
    stale_workers: number;
    dead_workers: number;
    dry_run: boolean;
    shutdown?: Record<string, unknown>;
  }>;
}> {
  const checkedAt = nowIso();
  const teamNames = await listTeamNames(cwd);
  const cleaned: Array<{
    team_name: string;
    reason: "all_workers_dead" | "no_healthy_workers";
    healthy_workers: number;
    stale_workers: number;
    dead_workers: number;
    dry_run: boolean;
    shutdown?: Record<string, unknown>;
  }> = [];
  let activeTeamCount = 0;

  for (const teamName of teamNames) {
    const status = await readTeamStatus(teamName, cwd);
    if (!status || !status.config.active || !status.phase.active) {
      continue;
    }

    activeTeamCount += 1;
    const snapshot = await monitorTeamRuntime(
      teamName,
      {
        staleAfterMs: options.staleAfterMs,
        deadAfterMs: options.deadAfterMs
      },
      cwd
    );
    const workerCount = snapshot.workers.length;
    if (workerCount === 0) {
      continue;
    }

    const deadOnly = snapshot.dead_workers === workerCount;
    const staleOnly = options.includeStale && snapshot.healthy_workers === 0;
    if (!deadOnly && !staleOnly) {
      continue;
    }

    cleaned.push({
      team_name: teamName,
      reason: deadOnly ? "all_workers_dead" : "no_healthy_workers",
      healthy_workers: snapshot.healthy_workers,
      stale_workers: snapshot.stale_workers,
      dead_workers: snapshot.dead_workers,
      dry_run: options.dryRun ?? false,
      ...(!(options.dryRun ?? false)
        ? { shutdown: await shutdownTeamRuntime(teamName, cwd) }
        : {})
    });
  }

  return {
    checked_at: checkedAt,
    team_count: teamNames.length,
    active_team_count: activeTeamCount,
    cleaned
  };
}

export async function sendWorkerMessage(
  teamName: string,
  workerName: string,
  body: string,
  cwd = process.cwd()
): Promise<Record<string, unknown>> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const status = await readTeamStatus(normalizedTeamName, cwd);
  if (!status) {
    throw new Error(`team not found: ${normalizedTeamName}`);
  }

  if (!status.config.worker_names.includes(workerName)) {
    throw new Error(`worker not found: ${workerName}`);
  }

  const timestamp = nowIso();
  const identity = await readWorkerIdentity(normalizedTeamName, workerName, cwd);
  const message: AgmoMailboxMessage = {
    message_id: createMessageId(),
    from_worker: "leader-fixed",
    to_worker: workerName,
    body,
    created_at: timestamp
  };

  await appendMailboxMessage(normalizedTeamName, workerName, message, cwd);

  const requests = await readDispatchRequests(normalizedTeamName, cwd);
  const request: AgmoDispatchRequest = {
    request_id: `req-${message.message_id}`,
    kind: "inbox",
    to_worker: workerName,
    pane_id: identity.pane_id,
    status: "pending",
    trigger_message: `AGMO: New inbox message for ${workerName}. Re-read ${resolveWorkerInboxPath(normalizedTeamName, workerName, cwd)} now and acknowledge in your next response.`,
    message_id: message.message_id,
    created_at: timestamp,
    transport_preference:
      status.config.transport === "tmux" ? "transport_direct" : "hook_preferred_with_fallback"
  };

  if (status.config.transport === "tmux" && identity.pane_id) {
    const delivered = notifyPane(identity.pane_id, request.trigger_message ?? body);
    const deliveryTimestamp = nowIso();
    request.status = delivered ? "notified" : "failed";
    if (delivered) {
      request.notified_at = deliveryTimestamp;
      message.notified_at = deliveryTimestamp;
    } else {
      request.failed_at = deliveryTimestamp;
    }
  }

  requests.push(request);

  if (message.notified_at || message.delivered_at) {
    await updateMailboxMessage(
      normalizedTeamName,
      workerName,
      message.message_id,
      message,
      cwd
    );
  }

  await Promise.all([
    writeDispatchRequests(normalizedTeamName, requests, cwd),
    writeEvent(
      normalizedTeamName,
      {
        timestamp: nowIso(),
        type: "worker_message_sent",
        team_name: normalizedTeamName,
        worker_name: workerName,
        message_id: message.message_id,
        dispatch_status: request.status
      },
      cwd
    )
  ]);

  return {
    team_name: normalizedTeamName,
    worker_name: workerName,
    message_id: message.message_id,
    dispatch_request_id: request.request_id,
    dispatch_status: request.status
  };
}

export async function acknowledgeDispatchRequest(
  teamName: string,
  requestId: string,
  cwd = process.cwd()
): Promise<Record<string, unknown>> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const requests = await readDispatchRequests(normalizedTeamName, cwd);
  const request = requests.find((entry) => entry.request_id === requestId);

  if (!request) {
    throw new Error(`dispatch request not found: ${requestId}`);
  }

  if (request.status === "delivered") {
    return {
      team_name: normalizedTeamName,
      request_id: requestId,
      status: request.status
    };
  }

  const timestamp = nowIso();
  request.status = "delivered";
  request.notified_at = request.notified_at ?? timestamp;
  request.delivered_at = timestamp;
  request.failed_at = undefined;

  await Promise.all([
    writeDispatchRequests(normalizedTeamName, requests, cwd),
    request.message_id
      ? updateMailboxMessage(
          normalizedTeamName,
          request.to_worker,
          request.message_id,
          {
            notified_at: request.notified_at,
            delivered_at: timestamp
          },
          cwd
        )
      : Promise.resolve(),
    writeEvent(
      normalizedTeamName,
      {
        timestamp,
        type: "dispatch_acknowledged",
        team_name: normalizedTeamName,
        worker_name: request.to_worker,
        request_id: request.request_id
      },
      cwd
    )
  ]);

  return {
    team_name: normalizedTeamName,
    request_id: request.request_id,
    worker_name: request.to_worker,
    status: request.status
  };
}

export async function retryDispatchRequests(
  teamName: string,
  workerName: string | undefined,
  cwd = process.cwd()
): Promise<Record<string, unknown>> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const status = await readTeamStatus(normalizedTeamName, cwd);
  if (!status) {
    throw new Error(`team not found: ${normalizedTeamName}`);
  }

  const requests = await readDispatchRequests(normalizedTeamName, cwd);
  const retriable = requests.filter((request) => {
    if (workerName && request.to_worker !== workerName) {
      return false;
    }
    return request.status === "pending" || request.status === "failed";
  });

  let retried = 0;
  let notified = 0;
  let failed = 0;

  for (const request of retriable) {
    const identity = status.workers.find(
      (worker) => worker.identity.name === request.to_worker
    )?.identity;
    const timestamp = nowIso();
    const sent =
      status.config.transport === "tmux" &&
      Boolean(identity?.pane_id) &&
      notifyPane(identity?.pane_id ?? "", request.trigger_message ?? "AGMO: Check inbox.");

    request.pane_id = identity?.pane_id;
    request.failed_at = undefined;

    if (sent) {
      request.status = "notified";
      request.notified_at = timestamp;
      retried += 1;
      notified += 1;
      if (request.message_id) {
        await updateMailboxMessage(
          normalizedTeamName,
          request.to_worker,
          request.message_id,
          {
            notified_at: timestamp
          },
          cwd
        );
      }
    } else {
      request.status = request.status === "failed" ? "failed" : "pending";
      request.failed_at = status.config.transport === "tmux" ? timestamp : undefined;
      retried += 1;
      failed += 1;
    }
  }

  await Promise.all([
    writeDispatchRequests(normalizedTeamName, requests, cwd),
    writeEvent(
      normalizedTeamName,
      {
        timestamp: nowIso(),
        type: "dispatch_retry",
        team_name: normalizedTeamName,
        worker_name: workerName,
        retried,
        notified,
        failed
      },
      cwd
    )
  ]);

  return {
    team_name: normalizedTeamName,
    worker_name: workerName,
    retried,
    notified,
    failed
  };
}

export async function claimTaskForWorker(
  teamName: string,
  taskId: string,
  workerName: string,
  options: {
    ignoreDependencies?: boolean;
  } = {},
  cwd = process.cwd()
): Promise<Record<string, unknown>> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const task = await readTaskRecord(normalizedTeamName, taskId, cwd);
  assertWorkerOwnsTask(task, workerName);
  const status = await readTeamStatus(normalizedTeamName, cwd);
  if (!status) {
    throw new Error(`team not found: ${normalizedTeamName}`);
  }
  const blockers = computeTaskDependencyBlockers(
    task,
    new Map(status.tasks.map((entry) => [entry.id, entry]))
  );

  if (blockers.length > 0 && !options.ignoreDependencies) {
    const blockedTask: AgmoTeamTaskRecord = {
      ...task,
      status: "blocked",
      blocked_by_dependencies: blockers,
      version: task.version + 1,
      updated_at: nowIso()
    };
    await Promise.all([
      writeTaskRecord(normalizedTeamName, blockedTask, cwd),
      writeEvent(
        normalizedTeamName,
        {
          timestamp: blockedTask.updated_at,
          type: "task_claim_blocked",
          team_name: normalizedTeamName,
          worker_name: workerName,
          task_id: taskId,
          blocked_by_dependencies: blockers
        },
        cwd
      )
    ]);
    const blockerSummary = blockers
      .map((entry) => `${entry.task_id}:${entry.status}`)
      .join(", ");
    throw new Error(
      `task ${taskId} is blocked by unresolved dependencies: ${blockerSummary}`
    );
  }

  const timestamp = nowIso();
  const nextTask: AgmoTeamTaskRecord = {
    ...task,
    owner: workerName,
    status: "in_progress",
    blocked_by_dependencies: undefined,
    claim: {
      owner: workerName,
      claimed_at: timestamp
    },
    error: undefined,
    version: task.version + 1,
    updated_at: timestamp
  };

  await Promise.all([
    writeTaskRecord(normalizedTeamName, nextTask, cwd),
    writeWorkerStatus(
      normalizedTeamName,
      workerName,
      {
        state: "working",
        current_task_id: taskId,
        updated_at: timestamp
      },
      cwd
    ),
    bumpWorkerHeartbeat(
      normalizedTeamName,
      workerName,
      { pid: resolveReportedWorkerPid() },
      cwd
    ),
    writeEvent(
      normalizedTeamName,
      {
        timestamp,
        type: "task_claimed",
        team_name: normalizedTeamName,
        worker_name: workerName,
        task_id: taskId,
        ignore_dependencies: options.ignoreDependencies ?? false
      },
      cwd
    )
  ]);

  return {
    team_name: normalizedTeamName,
    worker_name: workerName,
    ignored_dependencies: options.ignoreDependencies ?? false,
    task: nextTask
  };
}

export async function completeTaskForWorker(
  teamName: string,
  taskId: string,
  workerName: string,
  result: string | undefined,
  cwd = process.cwd()
): Promise<Record<string, unknown>> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const task = await readTaskRecord(normalizedTeamName, taskId, cwd);
  assertWorkerOwnsTask(task, workerName);

  const timestamp = nowIso();
  const nextTask: AgmoTeamTaskRecord = {
    ...task,
    owner: workerName,
    status: "completed",
    claim_history: task.claim
      ? [
          ...(task.claim_history ?? []),
          {
            owner: task.claim.owner,
            claimed_at: task.claim.claimed_at,
            released_at: timestamp,
            release_reason: "completed",
            successor_owner: workerName
          }
        ]
      : task.claim_history,
    claim: undefined,
    result,
    error: undefined,
    version: task.version + 1,
    updated_at: timestamp
  };

  await Promise.all([
    writeTaskRecord(normalizedTeamName, nextTask, cwd),
    writeWorkerStatus(
      normalizedTeamName,
      workerName,
      {
        state: "done",
        current_task_id: taskId,
        updated_at: timestamp
      },
      cwd
    ),
    bumpWorkerHeartbeat(
      normalizedTeamName,
      workerName,
      { pid: resolveReportedWorkerPid() },
      cwd
    ),
    writeEvent(
      normalizedTeamName,
      {
        timestamp,
        type: "task_completed",
        team_name: normalizedTeamName,
        worker_name: workerName,
        task_id: taskId
      },
      cwd
    )
  ]);
  const dependencyUpdates = await refreshTeamDependencyStates(normalizedTeamName, cwd);

  return {
    team_name: normalizedTeamName,
    worker_name: workerName,
    task: nextTask,
    dependency_updates: dependencyUpdates.updated
  };
}

export async function failTaskForWorker(
  teamName: string,
  taskId: string,
  workerName: string,
  error: string | undefined,
  cwd = process.cwd()
): Promise<Record<string, unknown>> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const task = await readTaskRecord(normalizedTeamName, taskId, cwd);
  assertWorkerOwnsTask(task, workerName);

  const timestamp = nowIso();
  const nextTask: AgmoTeamTaskRecord = {
    ...task,
    owner: workerName,
    status: "failed",
    claim_history: task.claim
      ? [
          ...(task.claim_history ?? []),
          {
            owner: task.claim.owner,
            claimed_at: task.claim.claimed_at,
            released_at: timestamp,
            release_reason: "failed",
            successor_owner: workerName
          }
        ]
      : task.claim_history,
    claim: undefined,
    error: error ?? "task failed",
    version: task.version + 1,
    updated_at: timestamp
  };

  await Promise.all([
    writeTaskRecord(normalizedTeamName, nextTask, cwd),
    writeWorkerStatus(
      normalizedTeamName,
      workerName,
      {
        state: "blocked",
        current_task_id: taskId,
        updated_at: timestamp
      },
      cwd
    ),
    bumpWorkerHeartbeat(
      normalizedTeamName,
      workerName,
      { pid: resolveReportedWorkerPid() },
      cwd
    ),
    writeEvent(
      normalizedTeamName,
      {
        timestamp,
        type: "task_failed",
        team_name: normalizedTeamName,
        worker_name: workerName,
        task_id: taskId,
        error: nextTask.error
      },
      cwd
    )
  ]);
  const dependencyUpdates = await refreshTeamDependencyStates(normalizedTeamName, cwd);

  return {
    team_name: normalizedTeamName,
    worker_name: workerName,
    task: nextTask,
    dependency_updates: dependencyUpdates.updated
  };
}

export async function heartbeatWorker(
  teamName: string,
  workerName: string,
  cwd = process.cwd()
): Promise<Record<string, unknown>> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  await readWorkerIdentity(normalizedTeamName, workerName, cwd);
  await Promise.all([
    bumpWorkerHeartbeat(
      normalizedTeamName,
      workerName,
      { pid: resolveReportedWorkerPid() },
      cwd
    ),
    writeEvent(
      normalizedTeamName,
      {
        timestamp: nowIso(),
        type: "worker_heartbeat",
        team_name: normalizedTeamName,
        worker_name: workerName
      },
      cwd
    )
  ]);

  const heartbeat = await readJsonFile<AgmoWorkerHeartbeat>(
    resolveWorkerHeartbeatPath(normalizedTeamName, workerName, cwd)
  );

  return {
    team_name: normalizedTeamName,
    worker_name: workerName,
    heartbeat
  };
}

export async function reportWorkerStatus(
  teamName: string,
  workerName: string,
  state: AgmoWorkerStatus["state"],
  options: {
    taskId?: string;
    note?: string;
  } = {},
  cwd = process.cwd()
): Promise<Record<string, unknown>> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  await readWorkerIdentity(normalizedTeamName, workerName, cwd);

  if (options.taskId) {
    const task = await readTaskRecord(normalizedTeamName, options.taskId, cwd);
    assertWorkerOwnsTask(task, workerName);
  }

  const timestamp = nowIso();
  const nextStatus: AgmoWorkerStatus = {
    state,
    current_task_id: options.taskId,
    updated_at: timestamp
  };

  await Promise.all([
    writeWorkerStatus(normalizedTeamName, workerName, nextStatus, cwd),
    bumpWorkerHeartbeat(
      normalizedTeamName,
      workerName,
      { pid: resolveReportedWorkerPid() },
      cwd
    ),
    writeEvent(
      normalizedTeamName,
      {
        timestamp,
        type: "worker_status_reported",
        team_name: normalizedTeamName,
        worker_name: workerName,
        state,
        task_id: options.taskId,
        note: options.note
      },
      cwd
    )
  ]);

  return {
    team_name: normalizedTeamName,
    worker_name: workerName,
    status: nextStatus
  };
}

export async function recordWorkerHookActivity(
  teamName: string,
  workerName: string,
  eventName: string,
  cwd = process.cwd()
): Promise<void> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  await readWorkerIdentity(normalizedTeamName, workerName, cwd);

  const currentStatus = await readWorkerStatusRecord(normalizedTeamName, workerName, cwd);
  const requests = await readDispatchRequests(normalizedTeamName, cwd);
  const timestamp = nowIso();
  const nextStatus =
    (eventName === "UserPromptSubmit" || eventName === "PreToolUse") &&
    currentStatus.state === "idle"
      ? {
          ...currentStatus,
          state: "working" as const,
          updated_at: timestamp
        }
      : null;
  const ackedRequests = requests.filter(
    (request) =>
      request.to_worker === workerName &&
      (request.status === "pending" || request.status === "notified")
  );

  for (const request of ackedRequests) {
    request.status = "delivered";
    request.notified_at = request.notified_at ?? timestamp;
    request.delivered_at = timestamp;
    request.failed_at = undefined;

    if (request.message_id) {
      await updateMailboxMessage(
        normalizedTeamName,
        workerName,
        request.message_id,
        {
          notified_at: request.notified_at,
          delivered_at: timestamp
        },
        cwd
      );
    }
  }

  await Promise.all([
    bumpWorkerHeartbeat(
      normalizedTeamName,
      workerName,
      { pid: resolveReportedWorkerPid() },
      cwd
    ),
    ackedRequests.length > 0
      ? writeDispatchRequests(normalizedTeamName, requests, cwd)
      : Promise.resolve(),
    nextStatus
      ? writeWorkerStatus(normalizedTeamName, workerName, nextStatus, cwd)
      : Promise.resolve(),
    writeEvent(
      normalizedTeamName,
      {
        timestamp,
        type: "worker_hook_activity",
        team_name: normalizedTeamName,
        worker_name: workerName,
        event_name: eventName,
        acked_dispatch_count: ackedRequests.length
      },
      cwd
    )
  ]);
}

export async function monitorTeamRuntime(
  teamName: string,
  options: {
    staleAfterMs?: number;
    deadAfterMs?: number;
  } = {},
  cwd = process.cwd()
): Promise<AgmoTeamMonitorSnapshot> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const status = await readTeamStatus(normalizedTeamName, cwd);

  if (!status) {
    throw new Error(`team not found: ${normalizedTeamName}`);
  }

  const staleAfterMs = options.staleAfterMs ?? 2 * 60 * 1000;
  const deadAfterMs = Math.max(options.deadAfterMs ?? 10 * 60 * 1000, staleAfterMs + 1);
  const checkedAt = nowIso();
  const checkedAtMs = Date.parse(checkedAt);

  const workers: AgmoWorkerMonitorSnapshot[] = [];

  for (const worker of status.workers) {
    const pendingDispatchCount = status.dispatch_requests.filter(
      (request) =>
        request.to_worker === worker.identity.name &&
        (request.status === "pending" || request.status === "notified")
    ).length;
    const mailboxMessageCount = status.mailbox[worker.identity.name]?.length ?? 0;
    const heartbeatAtMs =
      parseTimestampMs(worker.heartbeat.last_turn_at) ?? checkedAtMs - deadAfterMs - 1;
    const msSinceHeartbeat = Math.max(0, checkedAtMs - heartbeatAtMs);
    const pidAlive =
      typeof worker.heartbeat.pid === "number" && worker.heartbeat.pid > 0
        ? isPidAlive(worker.heartbeat.pid)
        : null;
    const reasons: string[] = [];

    let health: AgmoWorkerHealth = "healthy";
    if (pidAlive === false || msSinceHeartbeat >= deadAfterMs) {
      health = "dead";
      if (pidAlive === false) {
        reasons.push("pid_unreachable");
      }
      if (msSinceHeartbeat >= deadAfterMs) {
        reasons.push("heartbeat_dead_timeout");
      }
    } else if (msSinceHeartbeat >= staleAfterMs) {
      health = "stale";
      reasons.push("heartbeat_stale_timeout");
    }

    if (pendingDispatchCount > 0) {
      reasons.push("pending_dispatch");
    }

    const currentTask = worker.status.current_task_id
      ? status.tasks.find((task) => task.id === worker.status.current_task_id)
      : undefined;
    const claimAgeMs =
      parseTimestampMs(currentTask?.claim?.claimed_at) !== null
        ? checkedAtMs - (parseTimestampMs(currentTask?.claim?.claimed_at) ?? checkedAtMs)
        : 0;
    const claimAtRisk =
      worker.status.state === "working" &&
      Boolean(currentTask?.claim?.owner === worker.identity.name) &&
      (health !== "healthy" || claimAgeMs > DEFAULT_TASK_CLAIM_LEASE_MS);

    if (claimAtRisk && claimAgeMs > DEFAULT_TASK_CLAIM_LEASE_MS) {
      reasons.push("claim_lease_expired");
    }

    if (pidAlive !== null && worker.heartbeat.alive !== pidAlive) {
      await writeWorkerHeartbeat(
        normalizedTeamName,
        worker.identity.name,
        {
          ...worker.heartbeat,
          alive: pidAlive
        },
        cwd
      );
    }

    workers.push({
      worker_name: worker.identity.name,
      role: worker.identity.role,
      status_state: worker.status.state,
      current_task_id: worker.status.current_task_id,
      heartbeat_at: worker.heartbeat.last_turn_at,
      ms_since_heartbeat: msSinceHeartbeat,
      pid: worker.heartbeat.pid,
      pid_alive: pidAlive,
      heartbeat_alive_flag: worker.heartbeat.alive,
      turn_count: worker.heartbeat.turn_count,
      health,
      pending_dispatch_count: pendingDispatchCount,
      mailbox_message_count: mailboxMessageCount,
      pane_id: worker.identity.pane_id,
      claim_at_risk: claimAtRisk,
      reasons
    });
  }

  const snapshot: AgmoTeamMonitorSnapshot = {
    team_name: normalizedTeamName,
    checked_at: checkedAt,
    stale_after_ms: staleAfterMs,
    dead_after_ms: deadAfterMs,
    active_workers: workers.filter((worker) => worker.status_state === "working").length,
    healthy_workers: workers.filter((worker) => worker.health === "healthy").length,
    stale_workers: workers.filter((worker) => worker.health === "stale").length,
    dead_workers: workers.filter((worker) => worker.health === "dead").length,
    workers
  };

  await Promise.all([
    writeJsonFile(resolveTeamMonitorSnapshotPath(normalizedTeamName, cwd), snapshot),
    writeEvent(
      normalizedTeamName,
      {
        timestamp: checkedAt,
        type: "team_monitor_snapshot",
        team_name: normalizedTeamName,
        stale_workers: snapshot.stale_workers,
        dead_workers: snapshot.dead_workers
      },
      cwd
    )
  ]);

  return snapshot;
}

export async function autoNudgeTeamRuntime(
  teamName: string,
  snapshot: AgmoTeamMonitorSnapshot,
  options: {
    cooldownMs?: number;
    workerName?: string;
  } = {},
  cwd = process.cwd()
): Promise<{
  team_name: string;
  nudges: Array<
    AgmoLeaderNudgeRecord & {
      status: "sent" | "cooldown_skipped";
    }
  >;
}> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const cooldownMs = Math.max(options.cooldownMs ?? 5 * 60 * 1000, 0);
  const checkedAtMs = Date.parse(snapshot.checked_at);
  const existingState =
    (await readLeaderNudgeState(normalizedTeamName, cwd)) ?? {
      updated_at: snapshot.checked_at,
      cooldown_ms: cooldownMs,
      by_worker: {},
      history: []
    };

  const nudges: Array<
    AgmoLeaderNudgeRecord & {
      status: "sent" | "cooldown_skipped";
    }
  > = [];

  for (const worker of snapshot.workers) {
    if (options.workerName && worker.worker_name !== options.workerName) {
      continue;
    }

    const shouldNudge =
      worker.health === "stale" || worker.health === "dead" || worker.claim_at_risk;
    const shouldRetryDispatch = worker.pending_dispatch_count > 0;

    if (!shouldNudge && !shouldRetryDispatch) {
      continue;
    }

    const fingerprint = buildWorkerNudgeFingerprint(worker);
    const previous = existingState.by_worker[worker.worker_name];
    const previousAtMs = parseTimestampMs(previous?.nudged_at) ?? 0;
    const sameSituation = previous?.fingerprint === fingerprint;
    const withinCooldown =
      sameSituation && checkedAtMs - previousAtMs >= 0 && checkedAtMs - previousAtMs < cooldownMs;

    let retrySummary: AgmoLeaderNudgeRecord["dispatch_retry"];
    if (shouldRetryDispatch) {
      const retryResult = await retryDispatchRequests(
        normalizedTeamName,
        worker.worker_name,
        cwd
      );
      retrySummary = {
        retried: Number(retryResult.retried ?? 0),
        notified: Number(retryResult.notified ?? 0),
        failed: Number(retryResult.failed ?? 0)
      };
    }

    if (!shouldNudge) {
      continue;
    }

    const cooldownUntil = new Date(checkedAtMs + cooldownMs).toISOString();
    const baseRecord: AgmoLeaderNudgeRecord = {
      worker_name: worker.worker_name,
      health: worker.health,
      reasons: worker.reasons,
      fingerprint,
      nudged_at: snapshot.checked_at,
      cooldown_until: cooldownUntil,
      dispatch_retry: retrySummary
    };

    if (withinCooldown) {
      nudges.push({
        ...baseRecord,
        ...(previous?.message_id ? { message_id: previous.message_id } : {}),
        ...(previous?.dispatch_request_id
          ? { dispatch_request_id: previous.dispatch_request_id }
          : {}),
        ...(previous?.dispatch_status ? { dispatch_status: previous.dispatch_status } : {}),
        status: "cooldown_skipped"
      });
      continue;
    }

    const sendResult = await sendWorkerMessage(
      normalizedTeamName,
      worker.worker_name,
      buildAutoNudgeMessage(normalizedTeamName, worker, cwd),
      cwd
    );

    const record: AgmoLeaderNudgeRecord = {
      ...baseRecord,
      message_id:
        typeof sendResult.message_id === "string" ? sendResult.message_id : undefined,
      dispatch_request_id:
        typeof sendResult.dispatch_request_id === "string"
          ? sendResult.dispatch_request_id
          : undefined,
      dispatch_status:
        sendResult.dispatch_status === "pending" ||
        sendResult.dispatch_status === "notified" ||
        sendResult.dispatch_status === "delivered" ||
        sendResult.dispatch_status === "failed"
          ? sendResult.dispatch_status
          : undefined
    };

    existingState.by_worker[worker.worker_name] = record;
    existingState.history = [...existingState.history, record].slice(-100);

    nudges.push({
      ...record,
      status: "sent"
    });

    await writeEvent(
      normalizedTeamName,
      {
        timestamp: snapshot.checked_at,
        type: "leader_auto_nudge",
        team_name: normalizedTeamName,
        worker_name: worker.worker_name,
        health: worker.health,
        reasons: worker.reasons,
        dispatch_request_id: record.dispatch_request_id,
        message_id: record.message_id
      },
      cwd
    );
  }

  existingState.updated_at = snapshot.checked_at;
  existingState.cooldown_ms = cooldownMs;
  await writeLeaderNudgeState(normalizedTeamName, existingState, cwd);

  return {
    team_name: normalizedTeamName,
    nudges
  };
}

export async function reclaimTeamClaims(
  teamName: string,
  options: {
    workerName?: string;
    taskId?: string;
    staleAfterMs?: number;
    deadAfterMs?: number;
    leaseMs?: number;
    reassign?: boolean;
    includeStale?: boolean;
  } = {},
  cwd = process.cwd()
): Promise<{
  team_name: string;
  lease_ms: number;
  reassign: boolean;
  include_stale: boolean;
  snapshot: AgmoTeamMonitorSnapshot;
  reclaimed: Array<{
    task_id: string;
    previous_owner: string;
    next_owner?: string;
    reasons: string[];
    claim_age_ms: number | null;
    reassigned: boolean;
    worker_notified: boolean;
  }>;
}> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const status = await readTeamStatus(normalizedTeamName, cwd);
  if (!status) {
    throw new Error(`team not found: ${normalizedTeamName}`);
  }

  const snapshot = await monitorTeamRuntime(
    normalizedTeamName,
    {
      staleAfterMs: options.staleAfterMs,
      deadAfterMs: options.deadAfterMs
    },
    cwd
  );
  const checkedAtMs = Date.parse(snapshot.checked_at);
  const leaseMs = Math.max(options.leaseMs ?? DEFAULT_TASK_CLAIM_LEASE_MS, 1);
  const includeStale = options.includeStale ?? false;
  const workerByName = new Map(snapshot.workers.map((worker) => [worker.worker_name, worker]));
  const reclaimed: Array<{
    task_id: string;
    previous_owner: string;
    next_owner?: string;
    reasons: string[];
    claim_age_ms: number | null;
    reassigned: boolean;
    worker_notified: boolean;
  }> = [];

  for (const task of status.tasks) {
    if (task.status !== "in_progress" || !task.claim?.owner) {
      continue;
    }
    if (options.taskId && task.id !== options.taskId) {
      continue;
    }
    if (options.workerName && task.claim.owner !== options.workerName) {
      continue;
    }

    const previousOwner = task.claim.owner;
    const workerSnapshot = workerByName.get(previousOwner);
    const claimAgeMs = computeClaimAgeMs(task, checkedAtMs);
    const reasons: string[] = [];

    if (workerSnapshot?.health === "dead") {
      reasons.push("worker_dead");
    } else if (includeStale && workerSnapshot?.health === "stale") {
      reasons.push("worker_stale");
    }

    if (claimAgeMs !== null && claimAgeMs > leaseMs) {
      reasons.push("claim_lease_expired");
    }

    if (reasons.length === 0) {
      continue;
    }

    const timestamp = nowIso();
    const nextOwner = options.reassign
      ? chooseReplacementWorker(
          task,
          status,
          snapshot,
          {
            allowBusyWorkers: false
          },
          [previousOwner]
        )
      : null;

    const nextTask: AgmoTeamTaskRecord = {
      ...task,
      owner: nextOwner ?? undefined,
      status: "pending",
      claim_history: [
        ...(task.claim_history ?? []),
        {
          owner: task.claim.owner,
          claimed_at: task.claim.claimed_at,
          released_at: timestamp,
          release_reason: reasons.join("+"),
          successor_owner: nextOwner ?? undefined
        }
      ],
      assignment_history: [
        ...(task.assignment_history ?? []),
        {
          owner: nextOwner ?? undefined,
          assigned_at: timestamp,
          reason: nextOwner
            ? `reassigned:${reasons.join("+")}`
            : `reclaimed:${reasons.join("+")}`
        }
      ],
      claim: undefined,
      updated_at: timestamp,
      version: task.version + 1
    };

    await writeTaskRecord(normalizedTeamName, nextTask, cwd);

    const previousWorkerStatus = await readWorkerStatusRecord(
      normalizedTeamName,
      previousOwner,
      cwd
    );
    if (previousWorkerStatus.current_task_id === task.id) {
      await writeWorkerStatus(
        normalizedTeamName,
        previousOwner,
        {
          state:
            workerSnapshot?.health === "dead" || workerSnapshot?.health === "stale"
              ? "blocked"
              : "idle",
          updated_at: timestamp
        },
        cwd
      );
    }

    let workerNotified = false;
    if (nextOwner) {
      await sendWorkerMessage(
        normalizedTeamName,
        nextOwner,
        [
          `Task ${task.id} has been reassigned to you in team ${normalizedTeamName}.`,
          `Previous owner: ${previousOwner}.`,
          `Reason: ${reasons.join(", ")}.`,
          `Read your inbox and claim the task when ready.`,
          `Task summary: ${task.subject}`
        ].join(" ")
      );
      workerNotified = true;
    }

    await writeEvent(
      normalizedTeamName,
      {
        timestamp,
        type: "task_claim_reclaimed",
        team_name: normalizedTeamName,
        task_id: task.id,
        previous_owner: previousOwner,
        next_owner: nextOwner,
        reasons,
        claim_age_ms: claimAgeMs
      },
      cwd
    );

    reclaimed.push({
      task_id: task.id,
      previous_owner: previousOwner,
      ...(nextOwner ? { next_owner: nextOwner } : {}),
      reasons,
      claim_age_ms: claimAgeMs,
      reassigned: Boolean(nextOwner),
      worker_notified: workerNotified
    });
  }

  return {
    team_name: normalizedTeamName,
    lease_ms: leaseMs,
    reassign: options.reassign ?? false,
    include_stale: includeStale,
    snapshot,
    reclaimed
  };
}

export async function rebalanceTeamAssignments(
  teamName: string,
  options: {
    workerName?: string;
    staleAfterMs?: number;
    deadAfterMs?: number;
    maxOpenDelta?: number;
    limit?: number;
    allowBusyWorkers?: boolean;
    strictRoleMatch?: boolean;
    maxOpenPerWorker?: number;
    maxPendingDispatch?: number;
  } = {},
  cwd = process.cwd()
): Promise<{
  team_name: string;
  max_open_delta: number;
  limit?: number;
  allow_busy_workers: boolean;
  strict_role_match: boolean;
  max_open_per_worker?: number;
  max_pending_dispatch?: number;
  snapshot: AgmoTeamMonitorSnapshot;
  rebalanced: Array<{
    task_id: string;
    previous_owner?: string;
    next_owner: string;
    reason: string;
    previous_owner_open_load: number;
    next_owner_open_load_before: number;
    worker_notified: boolean;
  }>;
}> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const status = await readTeamStatus(normalizedTeamName, cwd);
  if (!status) {
    throw new Error(`team not found: ${normalizedTeamName}`);
  }

  const snapshot = await monitorTeamRuntime(
    normalizedTeamName,
    {
      staleAfterMs: options.staleAfterMs,
      deadAfterMs: options.deadAfterMs
    },
    cwd
  );
  const maxOpenDelta = Math.max(options.maxOpenDelta ?? 1, 0);
  const loads = buildWorkerOpenTaskLoad(status);
  const monitorByWorker = new Map(snapshot.workers.map((worker) => [worker.worker_name, worker]));
  const rebalanced: Array<{
    task_id: string;
    previous_owner?: string;
    next_owner: string;
    reason: string;
    previous_owner_open_load: number;
    next_owner_open_load_before: number;
    worker_notified: boolean;
  }> = [];

  const pendingTasks = [...status.tasks]
    .filter((task) => task.status === "pending" && !task.claim)
    .filter((task) => (options.workerName ? task.owner === options.workerName : true))
    .sort((left, right) => {
      const leftAssignments = left.assignment_history?.length ?? 0;
      const rightAssignments = right.assignment_history?.length ?? 0;
      if (leftAssignments !== rightAssignments) {
        return leftAssignments - rightAssignments;
      }
      return left.id.localeCompare(right.id, undefined, { numeric: true });
    });

  for (const task of pendingTasks) {
    if (typeof options.limit === "number" && rebalanced.length >= options.limit) {
      break;
    }

    const previousOwner = task.owner;
    const previousOwnerMonitor = previousOwner ? monitorByWorker.get(previousOwner) : undefined;
    const previousOwnerLoad = previousOwner ? loads.get(previousOwner) ?? 0 : 0;
    const nextOwner = chooseRebalanceOwner(
      task,
      status,
      snapshot,
      loads,
      {
        allowBusyWorkers: options.allowBusyWorkers,
        strictRoleMatch: options.strictRoleMatch,
        maxOpenPerWorker: options.maxOpenPerWorker,
        maxPendingDispatch: options.maxPendingDispatch
      }
    );

    if (!nextOwner) {
      continue;
    }

    let reason: string | null = null;
    if (!previousOwner) {
      reason = "unassigned_pending_task";
    } else if (previousOwner === nextOwner) {
      continue;
    } else if (previousOwnerMonitor?.health !== "healthy") {
      reason = `owner_${previousOwnerMonitor?.health ?? "missing"}`;
    } else if (previousOwnerLoad - (loads.get(nextOwner) ?? 0) > maxOpenDelta) {
      reason = "open_load_imbalance";
    }

    if (!reason) {
      continue;
    }

    const timestamp = nowIso();
    const nextOwnerLoadBefore = loads.get(nextOwner) ?? 0;
    const nextTask: AgmoTeamTaskRecord = {
      ...task,
      owner: nextOwner,
      assignment_history: [
        ...(task.assignment_history ?? []),
        {
          owner: nextOwner,
          assigned_at: timestamp,
          reason: `rebalanced:${reason}`
        }
      ],
      version: task.version + 1,
      updated_at: timestamp
    };

    await writeTaskRecord(normalizedTeamName, nextTask, cwd);

    if (previousOwner) {
      loads.set(previousOwner, Math.max(0, (loads.get(previousOwner) ?? 0) - 1));
    }
    loads.set(nextOwner, nextOwnerLoadBefore + 1);

    await sendWorkerMessage(
      normalizedTeamName,
      nextOwner,
      [
        `Task ${task.id} has been rebalanced to you in team ${normalizedTeamName}.`,
        previousOwner ? `Previous owner: ${previousOwner}.` : "The task did not have an owner.",
        `Reason: ${reason}.`,
        `Task summary: ${task.subject}`,
        "Read your inbox and claim the task when ready."
      ].join(" ")
    );

    await writeEvent(
      normalizedTeamName,
      {
        timestamp,
        type: "task_rebalanced",
        team_name: normalizedTeamName,
        task_id: task.id,
        previous_owner: previousOwner,
        next_owner: nextOwner,
        reason
      },
      cwd
    );

    rebalanced.push({
      task_id: task.id,
      ...(previousOwner ? { previous_owner: previousOwner } : {}),
      next_owner: nextOwner,
      reason,
      previous_owner_open_load: previousOwnerLoad,
      next_owner_open_load_before: nextOwnerLoadBefore,
      worker_notified: true
    });
  }

  return {
    team_name: normalizedTeamName,
    max_open_delta: maxOpenDelta,
    allow_busy_workers: options.allowBusyWorkers ?? false,
    strict_role_match: options.strictRoleMatch ?? false,
    ...(typeof options.maxOpenPerWorker === "number"
      ? { max_open_per_worker: options.maxOpenPerWorker }
      : {}),
    ...(typeof options.maxPendingDispatch === "number"
      ? { max_pending_dispatch: options.maxPendingDispatch }
      : {}),
    ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
    snapshot,
    rebalanced
  };
}

export async function integrateTeamChanges(
  teamName: string,
  options: {
    workerName?: string;
    taskId?: string;
    strategy?: AgmoIntegrationStrategy;
    dryRun?: boolean;
    maxCommits?: number;
    batchSize?: number;
    batchOrder?: AgmoIntegrationBatchOrder;
    onConflict?: AgmoIntegrationConflictPolicy;
    onEmpty?: AgmoIntegrationEmptyPolicy;
    targetRef?: string;
    checkoutTarget?: boolean;
  } = {},
  cwd = process.cwd()
): Promise<{
  team_name: string;
  strategy: AgmoIntegrationStrategy;
  dry_run: boolean;
  repo_root: string;
  requested_target_ref: string;
  target_ref: string;
  target_source: AgmoIntegrationTargetSource;
  checked_out_target: boolean;
  on_conflict: AgmoIntegrationConflictPolicy;
  on_empty: AgmoIntegrationEmptyPolicy;
  max_commits?: number;
  batch_size?: number;
  batch_order: AgmoIntegrationBatchOrder;
  candidate_task_count: number;
  selected_task_count: number;
  integrations: AgmoTeamIntegrationAttempt[];
}> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const status = await readTeamStatus(normalizedTeamName, cwd);
  if (!status) {
    throw new Error(`team not found: ${normalizedTeamName}`);
  }

  const gitConfig = status.config.workspace.git;
  if (!gitConfig?.enabled) {
    throw new Error("team integration requires git worktree mode");
  }

  const repoRoot = gitConfig.repo_root;
  const strategy = options.strategy ?? "cherry-pick";
  const dryRun = options.dryRun ?? false;
  const onConflict = options.onConflict ?? "continue";
  const onEmpty = options.onEmpty ?? "skip";
  const maxCommits = options.maxCommits;
  const batchSize = options.batchSize;
  const batchOrder = options.batchOrder ?? "oldest";
  const initialCurrentRef =
    gitOutput(["branch", "--show-current"], repoRoot) ||
    gitOutput(["rev-parse", "--short", "HEAD"], repoRoot);
  const targetResolution = resolveIntegrationTargetRef(
    options.targetRef,
    initialCurrentRef,
    gitConfig.base_ref
  );

  if (!isGitWorkspaceClean(repoRoot, { includeUntracked: false })) {
    throw new Error(`repo root is not clean: ${repoRoot}`);
  }

  if (targetResolution.target_source !== "current") {
    const verifiedTarget = runGit(["rev-parse", "--verify", targetResolution.target_ref], repoRoot);
    if (!verifiedTarget.ok) {
      throw new Error(`target ref not found: ${targetResolution.target_ref}`);
    }
  }

  let currentRef = initialCurrentRef;
  let checkedOutTarget = false;
  if (targetResolution.target_ref !== initialCurrentRef) {
    if (!options.checkoutTarget) {
      throw new Error(
        `current git ref ${initialCurrentRef} does not match target ref ${targetResolution.target_ref}; use --checkout-target to switch automatically`
      );
    }

    const checkoutResult = runGit(["checkout", targetResolution.target_ref], repoRoot);
    if (!checkoutResult.ok) {
      throw new Error(checkoutResult.stderr);
    }

    checkedOutTarget = true;
    currentRef =
      gitOutput(["branch", "--show-current"], repoRoot) ||
      gitOutput(["rev-parse", "--short", "HEAD"], repoRoot);
  }

  const integrationState =
    (await readIntegrationState(normalizedTeamName, cwd)) ?? {
      updated_at: nowIso(),
      attempts: []
    };
  const integratedCommitSet = new Set(
    integrationState.attempts
      .filter((attempt) => attempt.status !== "planned" && attempt.status !== "skipped")
      .flatMap((attempt) => {
        const commits = new Set<string>();
        (attempt.applied_commits ?? []).forEach((commit) => commits.add(commit));
        (attempt.skipped_commits ?? []).forEach((commit) => commits.add(commit));
        if (attempt.status === "integrated") {
          attempt.commits.forEach((commit) => commits.add(commit));
        }
      return [...commits];
      })
  );

  const matchingCandidates = status.tasks.filter((task) => {
    if (task.status !== "completed" || !task.owner) {
      return false;
    }
    if (options.taskId && task.id !== options.taskId) {
      return false;
    }
    if (options.workerName && task.owner !== options.workerName) {
      return false;
    }
    return true;
  });
  const candidateEntries: Array<{
    task: AgmoTeamTaskRecord;
    identity: AgmoWorkerIdentity;
  }> = [];
  for (const task of sortIntegrationCandidates(matchingCandidates, batchOrder)) {
    const identity = await readWorkerIdentity(normalizedTeamName, task.owner as string, cwd);
    if (identity.git_branch) {
      const branchExists = runGit(["rev-parse", "--verify", identity.git_branch], repoRoot);
      if (branchExists.ok) {
        const revList = gitOutput(
          ["rev-list", "--reverse", `${currentRef}..${identity.git_branch}`],
          repoRoot
        )
          .split("\n")
          .map((entry) => entry.trim())
          .filter(Boolean);
        const pendingCommits = revList.filter((commit) => !integratedCommitSet.has(commit));
        const dirtyWorker = !isGitWorkspaceClean(identity.worktree_path, {
          ignorePaths: ["AGENTS.md", ".codex", ".agmo"]
        });
        if (pendingCommits.length === 0 && !dirtyWorker) {
          continue;
        }
      }
    }

    candidateEntries.push({ task, identity });
  }

  const candidates = candidateEntries.map((entry) => entry.task);
  const selectedEntries =
    typeof batchSize === "number" ? candidateEntries.slice(0, batchSize) : candidateEntries;
  const batchId = selectedEntries.length > 0 ? `int-batch-${randomUUID()}` : undefined;

  const attempts: AgmoTeamIntegrationAttempt[] = [];

  for (const [index, entry] of selectedEntries.entries()) {
    const task = entry.task;
    const workerName = task.owner as string;
    const identity = entry.identity;
    const attemptBase = {
      attempt_id: `int-${randomUUID()}`,
      task_id: task.id,
      worker_name: workerName,
      branch_name: identity.git_branch,
      strategy,
      dry_run: dryRun,
      ...(batchId ? { batch_id: batchId } : {}),
      batch_index: index + 1,
      batch_total: selectedEntries.length,
      requested_target_ref: targetResolution.requested_target_ref,
      target_ref: currentRef,
      target_source: targetResolution.target_source,
      started_at: nowIso()
    };

    if (!identity.git_branch) {
      const skipped: AgmoTeamIntegrationAttempt = {
        ...attemptBase,
        status: "skipped",
        reason: "worker_has_no_git_branch",
        commits: [],
        completed_at: nowIso()
      };
      attempts.push(skipped);
      integrationState.attempts.push(skipped);
      continue;
    }

    const branchExists = runGit(["rev-parse", "--verify", identity.git_branch], repoRoot);
    if (!branchExists.ok) {
      const skipped: AgmoTeamIntegrationAttempt = {
        ...attemptBase,
        status: "skipped",
        reason: "worker_branch_missing",
        commits: [],
        completed_at: nowIso()
      };
      attempts.push(skipped);
      integrationState.attempts.push(skipped);
      continue;
    }

    const revList = gitOutput(
      ["rev-list", "--reverse", `${currentRef}..${identity.git_branch}`],
      repoRoot
    )
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const pendingCommits = revList.filter((commit) => !integratedCommitSet.has(commit));
    const mergeCommits = pendingCommits.filter((commit) => isGitMergeCommit(commit, repoRoot));

    if (pendingCommits.length === 0) {
      const dirtyWorker = !isGitWorkspaceClean(identity.worktree_path, {
        ignorePaths: ["AGENTS.md", ".codex", ".agmo"]
      });
      const skipped: AgmoTeamIntegrationAttempt = {
        ...attemptBase,
        status: "skipped",
        reason: dirtyWorker ? "worker_has_uncommitted_changes" : "no_new_commits",
        commits: [],
        completed_at: nowIso()
      };
      attempts.push(skipped);
      integrationState.attempts.push(skipped);
      continue;
    }

    if (typeof maxCommits === "number" && pendingCommits.length > maxCommits) {
      const skipped: AgmoTeamIntegrationAttempt = {
        ...attemptBase,
        status: "skipped",
        reason: "max_commits_exceeded",
        commits: pendingCommits,
        completed_at: nowIso()
      };
      attempts.push(skipped);
      integrationState.attempts.push(skipped);
      continue;
    }

    if (mergeCommits.length > 0 && strategy === "cherry-pick") {
      const skipped: AgmoTeamIntegrationAttempt = {
        ...attemptBase,
        status: "skipped",
        reason: "worker_branch_has_merge_commits",
        commits: pendingCommits,
        completed_at: nowIso()
      };
      attempts.push(skipped);
      integrationState.attempts.push(skipped);
      continue;
    }

    if (strategy === "squash" && pendingCommits.length !== revList.length) {
      const skipped: AgmoTeamIntegrationAttempt = {
        ...attemptBase,
        status: "skipped",
        reason: "squash_requires_full_branch_pending",
        commits: pendingCommits,
        completed_at: nowIso()
      };
      attempts.push(skipped);
      integrationState.attempts.push(skipped);
      continue;
    }

    if (
      !isGitWorkspaceClean(identity.worktree_path, {
        ignorePaths: ["AGENTS.md", ".codex", ".agmo"]
      })
    ) {
      const skipped: AgmoTeamIntegrationAttempt = {
        ...attemptBase,
        status: "skipped",
        reason: "worker_has_uncommitted_changes",
        commits: pendingCommits,
        completed_at: nowIso()
      };
      attempts.push(skipped);
      integrationState.attempts.push(skipped);
      continue;
    }

    if (dryRun) {
      const planned: AgmoTeamIntegrationAttempt = {
        ...attemptBase,
        status: "planned",
        commits: pendingCommits,
        completed_at: nowIso()
      };
      attempts.push(planned);
      integrationState.attempts.push(planned);
      continue;
    }

    let failedReason: string | undefined;
    let conflictCommit: string | undefined;
    let conflictPaths: string[] | undefined;
    const appliedCommits: string[] = [];
    const skippedCommits: string[] = [];
    let createdCommit: string | undefined;
    if (strategy === "cherry-pick") {
      for (const commit of pendingCommits) {
        const cherryPick = runGit(["cherry-pick", "-x", commit], repoRoot);
        if (!cherryPick.ok) {
          if (isCherryPickEmpty(cherryPick.stderr) && onEmpty === "skip") {
            const skipResult = runGit(["cherry-pick", "--skip"], repoRoot);
            if (skipResult.ok) {
              skippedCommits.push(commit);
              continue;
            }
            failedReason = skipResult.stderr;
            abortGitIntegrationState(strategy, repoRoot);
            break;
          }

          const nextConflictPaths = listGitConflictedPaths(repoRoot);
          if (nextConflictPaths.length > 0 || /conflict/i.test(cherryPick.stderr)) {
            conflictCommit = commit;
            conflictPaths = nextConflictPaths;
            failedReason = cherryPick.stderr;
            abortGitIntegrationState(strategy, repoRoot);
            break;
          }

          failedReason = cherryPick.stderr;
          abortGitIntegrationState(strategy, repoRoot);
          break;
        }
        appliedCommits.push(commit);
      }
    } else {
      const mergeResult = runGit(["merge", "--squash", identity.git_branch as string], repoRoot);
      if (!mergeResult.ok) {
        const nextConflictPaths = listGitConflictedPaths(repoRoot);
        if (nextConflictPaths.length > 0 || /conflict/i.test(mergeResult.stderr)) {
          conflictCommit = pendingCommits.at(-1);
          conflictPaths = nextConflictPaths;
          failedReason = mergeResult.stderr;
          abortGitIntegrationState(strategy, repoRoot);
        } else {
          failedReason = mergeResult.stderr;
          abortGitIntegrationState(strategy, repoRoot);
        }
      } else if (isGitWorkspaceClean(repoRoot, { includeUntracked: false })) {
        if (onEmpty === "skip") {
          skippedCommits.push(...pendingCommits);
        } else {
          failedReason = "squash merge produced no changes to commit";
        }
      } else {
        const commitMessage = [
          `agmo: integrate task ${task.id} from ${workerName}`,
          "",
          `Strategy: squash`,
          `Worker branch: ${identity.git_branch}`,
          `Source commits: ${pendingCommits.join(", ")}`
        ].join("\n");
        const commitResult = runGit(["commit", "-m", commitMessage], repoRoot);
        if (!commitResult.ok) {
          if (isGitNothingToCommit(commitResult.stderr) && onEmpty === "skip") {
            skippedCommits.push(...pendingCommits);
            runGit(["reset", "--merge"], repoRoot);
          } else {
            failedReason = commitResult.stderr;
            runGit(["reset", "--merge"], repoRoot);
          }
        } else {
          appliedCommits.push(...pendingCommits);
          createdCommit = gitOutput(["rev-parse", "HEAD"], repoRoot);
        }
      }
    }

    [...appliedCommits, ...skippedCommits].forEach((commit) => integratedCommitSet.add(commit));
    const assistPath =
      conflictCommit || (failedReason && conflictPaths && conflictPaths.length > 0)
        ? await writeIntegrationAssistNote(
            normalizedTeamName,
            {
              attemptId: attemptBase.attempt_id,
              taskId: task.id,
              workerName,
              branchName: identity.git_branch,
              strategy,
              targetRef: currentRef,
              commits: pendingCommits,
              conflictCommit,
              conflictPaths,
              reason: failedReason
            },
            cwd
          )
        : undefined;
    const finalAttempt: AgmoTeamIntegrationAttempt = {
      ...attemptBase,
      status: conflictCommit ? "conflict" : failedReason ? "failed" : "integrated",
      ...(failedReason ? { reason: failedReason } : {}),
      commits: pendingCommits,
      ...(appliedCommits.length > 0 ? { applied_commits: appliedCommits } : {}),
      ...(skippedCommits.length > 0 ? { skipped_commits: skippedCommits } : {}),
      ...(conflictCommit ? { conflict_commit: conflictCommit } : {}),
      ...(conflictPaths && conflictPaths.length > 0 ? { conflict_paths: conflictPaths } : {}),
      ...(createdCommit ? { created_commit: createdCommit } : {}),
      ...(assistPath ? { assist_path: assistPath } : {}),
      completed_at: nowIso()
    };
    attempts.push(finalAttempt);
    integrationState.attempts.push(finalAttempt);

    if (!failedReason && !conflictCommit) {
      await writeEvent(
        normalizedTeamName,
        {
          timestamp: finalAttempt.completed_at,
          type: "task_integrated",
          team_name: normalizedTeamName,
          task_id: task.id,
          worker_name: workerName,
          commits: pendingCommits,
          ...(appliedCommits.length > 0 ? { applied_commits: appliedCommits } : {}),
          ...(skippedCommits.length > 0 ? { skipped_commits: skippedCommits } : {}),
          ...(createdCommit ? { created_commit: createdCommit } : {}),
          strategy,
          batch_id: batchId,
          batch_index: index + 1,
          batch_total: selectedEntries.length,
          requested_target_ref: targetResolution.requested_target_ref,
          target_ref: currentRef,
          target_source: targetResolution.target_source
        },
        cwd
      );
    } else if (conflictCommit) {
      await writeEvent(
        normalizedTeamName,
        {
          timestamp: finalAttempt.completed_at,
          type: "task_integration_conflict",
          team_name: normalizedTeamName,
          task_id: task.id,
          worker_name: workerName,
          commits: pendingCommits,
          ...(appliedCommits.length > 0 ? { applied_commits: appliedCommits } : {}),
          ...(skippedCommits.length > 0 ? { skipped_commits: skippedCommits } : {}),
          conflict_commit: conflictCommit,
          ...(conflictPaths && conflictPaths.length > 0 ? { conflict_paths: conflictPaths } : {}),
          ...(assistPath ? { assist_path: assistPath } : {}),
          strategy,
          batch_id: batchId,
          batch_index: index + 1,
          batch_total: selectedEntries.length,
          requested_target_ref: targetResolution.requested_target_ref,
          target_ref: currentRef,
          target_source: targetResolution.target_source,
          reason: failedReason
        },
        cwd
      );

      if (onConflict === "stop") {
        break;
      }
    } else {
      await writeEvent(
        normalizedTeamName,
        {
          timestamp: finalAttempt.completed_at,
          type: "task_integration_failed",
          team_name: normalizedTeamName,
          task_id: task.id,
          worker_name: workerName,
          commits: pendingCommits,
          strategy,
          batch_id: batchId,
          batch_index: index + 1,
          batch_total: selectedEntries.length,
          requested_target_ref: targetResolution.requested_target_ref,
          target_ref: currentRef,
          target_source: targetResolution.target_source,
          reason: failedReason,
          ...(assistPath ? { assist_path: assistPath } : {})
        },
        cwd
      );
    }
  }

  integrationState.updated_at = nowIso();
  integrationState.attempts = integrationState.attempts.slice(-200);
  await writeIntegrationState(normalizedTeamName, integrationState, cwd);

  return {
    team_name: normalizedTeamName,
    strategy,
    dry_run: dryRun,
    repo_root: repoRoot,
    requested_target_ref: targetResolution.requested_target_ref,
    target_ref: currentRef,
    target_source: targetResolution.target_source,
    checked_out_target: checkedOutTarget,
    on_conflict: onConflict,
    on_empty: onEmpty,
    ...(typeof maxCommits === "number" ? { max_commits: maxCommits } : {}),
    ...(typeof batchSize === "number" ? { batch_size: batchSize } : {}),
    batch_order: batchOrder,
    candidate_task_count: candidates.length,
    selected_task_count: selectedEntries.length,
    integrations: attempts
  };
}

export async function readTeamIntegrationAssist(
  teamName: string,
  options: {
    attemptId?: string;
    taskId?: string;
  } = {},
  cwd = process.cwd()
): Promise<{
  team_name: string;
  attempt_id: string;
  task_id: string;
  path: string;
  markdown: string;
} | null> {
  const normalizedTeamName = sanitizeTeamName(teamName);
  const integrationState = await readIntegrationState(normalizedTeamName, cwd);
  if (!integrationState) {
    return null;
  }

  const candidates = [...integrationState.attempts]
    .filter((attempt) => Boolean(attempt.assist_path))
    .filter((attempt) => (options.attemptId ? attempt.attempt_id === options.attemptId : true))
    .filter((attempt) => (options.taskId ? attempt.task_id === options.taskId : true))
    .sort((left, right) => right.completed_at.localeCompare(left.completed_at));
  const latest = candidates[0];
  if (!latest?.assist_path) {
    return null;
  }

  const markdown = await readTextFileIfExists(latest.assist_path);
  if (markdown === null) {
    return null;
  }

  return {
    team_name: normalizedTeamName,
    attempt_id: latest.attempt_id,
    task_id: latest.task_id,
    path: latest.assist_path,
    markdown
  };
}

export function describeTeamRuntime(request: TeamStartRequest): Record<string, unknown> {
  return {
    request,
    architecture: {
      transport: "tmux",
      state_root: ".agmo/state/team",
      workspace: "worktree-per-worker",
      dispatch: "hook-preferred-with-fallback"
    }
  };
}
