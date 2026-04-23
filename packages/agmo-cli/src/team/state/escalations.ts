export type AgmoLeaderEscalationKind =
  | "stale_worker"
  | "dead_worker"
  | "claim_at_risk";

export type AgmoLeaderEscalationSeverity = "warn" | "critical";

export type AgmoLeaderEscalationRecord = {
  alert_id: string;
  worker_name: string;
  kind: AgmoLeaderEscalationKind;
  severity: AgmoLeaderEscalationSeverity;
  fingerprint: string;
  reasons: string[];
  repeat_count: number;
  first_seen_at: string;
  last_seen_at: string;
  alert_at?: string;
  cooldown_until?: string;
};

export type AgmoLeaderEscalationState = {
  updated_at: string;
  cooldown_ms: number;
  repeat_threshold: number;
  by_key: Record<string, AgmoLeaderEscalationRecord>;
  history: AgmoLeaderEscalationRecord[];
};
