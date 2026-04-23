export type AgmoWorkerHeartbeat = {
  pid?: number;
  alive: boolean;
  turn_count: number;
  last_turn_at: string;
};

export type AgmoWorkerStatus = {
  state: "idle" | "working" | "done" | "blocked";
  current_task_id?: string;
  updated_at: string;
};

export type AgmoWorkerHealth = "healthy" | "stale" | "dead";

export type AgmoWorkerMonitorSnapshot = {
  worker_name: string;
  role: string;
  status_state: AgmoWorkerStatus["state"];
  current_task_id?: string;
  heartbeat_at: string;
  ms_since_heartbeat: number;
  pid?: number;
  pid_alive: boolean | null;
  heartbeat_alive_flag: boolean;
  turn_count: number;
  health: AgmoWorkerHealth;
  pending_dispatch_count: number;
  mailbox_message_count: number;
  pane_id?: string;
  claim_at_risk: boolean;
  reasons: string[];
};

export type AgmoTeamMonitorSnapshot = {
  team_name: string;
  checked_at: string;
  stale_after_ms: number;
  dead_after_ms: number;
  active_workers: number;
  healthy_workers: number;
  stale_workers: number;
  dead_workers: number;
  workers: AgmoWorkerMonitorSnapshot[];
};
