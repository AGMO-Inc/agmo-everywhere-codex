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

export type AgmoTmuxPaneHealth = "live" | "missing" | "orphaned" | "unknown";

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

export type AgmoTmuxPaneMonitorSnapshot = {
  role: "leader" | "hud" | "worker";
  worker_name?: string;
  pane_id?: string | null;
  session_id?: string | null;
  health: AgmoTmuxPaneHealth;
  reasons: string[];
};

export type AgmoTmuxLayoutHealth = "ok" | "degraded" | "repairable" | "unknown" | "skipped";

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
  leader?: AgmoTmuxPaneMonitorSnapshot;
  hud?: AgmoTmuxPaneMonitorSnapshot;
  worker_panes?: AgmoTmuxPaneMonitorSnapshot[];
  layout_health?: AgmoTmuxLayoutHealth;
  tmux_health?: {
    transport: "tmux" | "none";
    leader: AgmoTmuxPaneHealth | "not_configured";
    hud: AgmoTmuxPaneHealth | "not_configured";
    workers: Record<string, AgmoTmuxPaneHealth | "not_configured">;
    layout: AgmoTmuxLayoutHealth;
    retry_pending: number;
    retry_manual_required: number;
    orphan_warnings: string[];
  };
};
