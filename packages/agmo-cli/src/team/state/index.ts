import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { AgmoLeaderAlertDeliveryState } from "./alerts.js";
import type { AgmoDispatchRequest } from "./dispatch.js";
import type { AgmoLeaderEscalationState } from "./escalations.js";
import type { AgmoTeamIntegrationState } from "./integrations.js";
import type { AgmoMailboxMessage } from "./mailbox.js";
import type { AgmoWorkerHeartbeat, AgmoWorkerStatus } from "./monitor.js";
import type { AgmoLeaderNudgeState } from "./nudges.js";
import type { AgmoTeamTaskRecord } from "./tasks.js";

export const AGMO_TEAM_STATE_ROOT = ".agmo/state/team";

export type AgmoTeamPhase =
  | "created"
  | "active"
  | "shutdown"
  | "cancelled";

export type AgmoTeamConfig = {
  name: string;
  created_at: string;
  updated_at: string;
  session_id?: string | null;
  active: boolean;
  phase: AgmoTeamPhase;
  task: string;
  worker_count: number;
  worker_names: string[];
  transport: "tmux" | "none";
  tmux: {
    available: boolean;
    in_tmux_client: boolean;
    leader_pane_id: string | null;
    hud_pane_id?: string | null;
    hud_refresh_ms?: number | null;
    hud_clear_screen?: boolean;
    worker_pane_ids: Record<string, string>;
  };
  workspace: {
    strategy: "git-worktree-per-worker" | "worktree-per-worker";
    root: string;
    git?: {
      enabled: boolean;
      repo_root: string;
      base_ref: string;
    };
  };
  initial_allocation?: {
    intent?: "implementation" | "verification" | "planning" | "knowledge";
    role_map?: Record<string, string>;
  };
};

export type AgmoTeamManifest = {
  version: 1;
  team_name: string;
  created_at: string;
  session_id?: string | null;
  task: string;
  worker_count: number;
  worker_names: string[];
};

export type AgmoTeamPhaseState = {
  current_phase: AgmoTeamPhase;
  updated_at: string;
  active: boolean;
};

export type AgmoWorkerIdentity = {
  name: string;
  role: string;
  index: number;
  working_dir: string;
  worktree_path: string;
  team_state_root: string;
  pane_id?: string;
  git_branch?: string;
};

export type AgmoTeamStatusSnapshot = {
  config: AgmoTeamConfig;
  manifest: AgmoTeamManifest;
  phase: AgmoTeamPhaseState;
  tasks: AgmoTeamTaskRecord[];
  workers: Array<{
    identity: AgmoWorkerIdentity;
    status: AgmoWorkerStatus;
    heartbeat: AgmoWorkerHeartbeat;
    inbox_path: string;
    mailbox_path: string;
  }>;
  mailbox: Record<string, AgmoMailboxMessage[]>;
  dispatch_requests: AgmoDispatchRequest[];
  leader_alert_delivery?: AgmoLeaderAlertDeliveryState | null;
  leader_escalations?: AgmoLeaderEscalationState | null;
  leader_nudges?: AgmoLeaderNudgeState | null;
  integrations?: AgmoTeamIntegrationState | null;
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function sanitizeTeamName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

  if (!normalized) {
    throw new Error("team name is empty after sanitization");
  }

  return normalized;
}

export function slugifyTask(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized.slice(0, 24) || "team-task";
}

export function generateTeamName(task: string): string {
  return `${slugifyTask(task)}-${Date.now().toString(36)}`;
}

export function buildWorkerNames(workerCount: number): string[] {
  return Array.from({ length: workerCount }, (_, index) => `worker-${index + 1}`);
}

export function resolveTeamStateRoot(cwd = process.cwd()): string {
  return resolve(cwd, AGMO_TEAM_STATE_ROOT);
}

export function resolveTeamDir(teamName: string, cwd = process.cwd()): string {
  return join(resolveTeamStateRoot(cwd), sanitizeTeamName(teamName));
}

export function resolveTeamConfigPath(teamName: string, cwd = process.cwd()): string {
  return join(resolveTeamDir(teamName, cwd), "config.json");
}

export function resolveTeamManifestPath(teamName: string, cwd = process.cwd()): string {
  return join(resolveTeamDir(teamName, cwd), "manifest.json");
}

export function resolveTeamPhasePath(teamName: string, cwd = process.cwd()): string {
  return join(resolveTeamDir(teamName, cwd), "phase.json");
}

export function resolveTeamTasksDir(teamName: string, cwd = process.cwd()): string {
  return join(resolveTeamDir(teamName, cwd), "tasks");
}

export function resolveTeamTaskPath(
  teamName: string,
  taskId: string,
  cwd = process.cwd()
): string {
  return join(resolveTeamTasksDir(teamName, cwd), `task-${taskId}.json`);
}

export function resolveTeamWorkersDir(teamName: string, cwd = process.cwd()): string {
  return join(resolveTeamDir(teamName, cwd), "workers");
}

export function resolveWorkerDir(
  teamName: string,
  workerName: string,
  cwd = process.cwd()
): string {
  return join(resolveTeamWorkersDir(teamName, cwd), workerName);
}

export function resolveWorkerIdentityPath(
  teamName: string,
  workerName: string,
  cwd = process.cwd()
): string {
  return join(resolveWorkerDir(teamName, workerName, cwd), "identity.json");
}

export function resolveWorkerStatusPath(
  teamName: string,
  workerName: string,
  cwd = process.cwd()
): string {
  return join(resolveWorkerDir(teamName, workerName, cwd), "status.json");
}

export function resolveWorkerHeartbeatPath(
  teamName: string,
  workerName: string,
  cwd = process.cwd()
): string {
  return join(resolveWorkerDir(teamName, workerName, cwd), "heartbeat.json");
}

export function resolveWorkerInboxPath(
  teamName: string,
  workerName: string,
  cwd = process.cwd()
): string {
  return join(resolveWorkerDir(teamName, workerName, cwd), "inbox.md");
}

export function resolveWorkerInstructionsPath(
  teamName: string,
  workerName: string,
  cwd = process.cwd()
): string {
  return join(resolveWorkerDir(teamName, workerName, cwd), "AGENTS.md");
}

export function resolveTeamMailboxDir(teamName: string, cwd = process.cwd()): string {
  return join(resolveTeamDir(teamName, cwd), "mailbox");
}

export function resolveWorkerMailboxPath(
  teamName: string,
  workerName: string,
  cwd = process.cwd()
): string {
  return join(resolveTeamMailboxDir(teamName, cwd), `${workerName}.json`);
}

export function resolveTeamDispatchPath(teamName: string, cwd = process.cwd()): string {
  return join(resolveTeamDir(teamName, cwd), "dispatch", "requests.json");
}

export function resolveTeamEventsPath(teamName: string, cwd = process.cwd()): string {
  return join(resolveTeamDir(teamName, cwd), "events.ndjson");
}

export function resolveTeamMonitorSnapshotPath(
  teamName: string,
  cwd = process.cwd()
): string {
  return join(resolveTeamDir(teamName, cwd), "monitor-snapshot.json");
}

export function resolveTeamLeaderNudgesPath(
  teamName: string,
  cwd = process.cwd()
): string {
  return join(resolveTeamDir(teamName, cwd), "leader-nudges.json");
}

export function resolveTeamLeaderMonitorViewPath(
  teamName: string,
  cwd = process.cwd()
): string {
  return join(resolveTeamDir(teamName, cwd), "leader-monitor.md");
}

export function resolveTeamLeaderHudPath(
  teamName: string,
  cwd = process.cwd()
): string {
  return join(resolveTeamDir(teamName, cwd), "leader-hud.txt");
}

export function resolveTeamLeaderEscalationsPath(
  teamName: string,
  cwd = process.cwd()
): string {
  return join(resolveTeamDir(teamName, cwd), "leader-alerts.json");
}

export function resolveTeamLeaderAlertDeliveryPath(
  teamName: string,
  cwd = process.cwd()
): string {
  return join(resolveTeamDir(teamName, cwd), "leader-alert-delivery.json");
}

export function resolveTeamLeaderAlertDeliveryLogPath(
  teamName: string,
  cwd = process.cwd()
): string {
  return join(resolveTeamDir(teamName, cwd), "leader-alert-deliveries.json");
}

export function resolveTeamLeaderAlertMailboxMarkdownPath(
  teamName: string,
  cwd = process.cwd()
): string {
  return join(resolveTeamDir(teamName, cwd), "leader-alert-mailbox.md");
}

export function resolveTeamLeaderAlertMailboxJsonlPath(
  teamName: string,
  cwd = process.cwd()
): string {
  return join(resolveTeamDir(teamName, cwd), "leader-alert-mailbox.ndjson");
}

export function resolveTeamMonitorPolicyPath(
  teamName: string,
  cwd = process.cwd()
): string {
  return join(resolveTeamDir(teamName, cwd), "monitor-policy.json");
}

export function resolveTeamIntegrationsPath(
  teamName: string,
  cwd = process.cwd()
): string {
  return join(resolveTeamDir(teamName, cwd), "integrations.json");
}

export function resolveTeamIntegrationAssistPath(
  teamName: string,
  attemptId: string,
  cwd = process.cwd()
): string {
  return join(resolveTeamDir(teamName, cwd), "integration-assists", `${attemptId}.md`);
}

export function buildDefaultWorkerStatus(): AgmoWorkerStatus {
  return {
    state: "idle",
    updated_at: nowIso()
  };
}

export function buildDefaultWorkerHeartbeat(): AgmoWorkerHeartbeat {
  return {
    alive: false,
    turn_count: 0,
    last_turn_at: nowIso()
  };
}

export function buildShutdownWorkerStatus(updatedAt = nowIso()): AgmoWorkerStatus {
  return {
    state: "idle",
    updated_at: updatedAt
  };
}

export function buildShutdownWorkerHeartbeat(
  previous?: AgmoWorkerHeartbeat | null,
  updatedAt = nowIso()
): AgmoWorkerHeartbeat {
  return {
    alive: false,
    turn_count: previous?.turn_count ?? 0,
    last_turn_at: updatedAt
  };
}

export function createMessageId(): string {
  return `msg-${randomUUID()}`;
}
