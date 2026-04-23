export type AgmoMonitorPolicyPreset =
  | "observe"
  | "conservative"
  | "balanced"
  | "aggressive";

export type AgmoTeamMonitorPolicyState = {
  updated_at: string;
  preset: AgmoMonitorPolicyPreset;
  stale_after_ms: number;
  dead_after_ms: number;
  auto_nudge: boolean;
  auto_reclaim: boolean;
  auto_reassign: boolean;
  include_stale: boolean;
  nudge_cooldown_ms: number;
  reclaim_lease_ms: number;
  escalate_leader: boolean;
  notify_on_stale: boolean;
  notify_on_dead: boolean;
  notify_on_claim_risk: boolean;
  leader_alert_cooldown_ms: number;
  escalation_repeat_threshold: number;
};
