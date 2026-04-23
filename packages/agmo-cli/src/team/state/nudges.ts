import type { AgmoWorkerHealth } from "./monitor.js";

export type AgmoLeaderNudgeRecord = {
  worker_name: string;
  health: AgmoWorkerHealth;
  reasons: string[];
  fingerprint: string;
  nudged_at: string;
  cooldown_until: string;
  message_id?: string;
  dispatch_request_id?: string;
  dispatch_status?: "pending" | "notified" | "delivered" | "failed";
  dispatch_retry?: {
    retried: number;
    notified: number;
    failed: number;
  };
};

export type AgmoLeaderNudgeState = {
  updated_at: string;
  cooldown_ms: number;
  by_worker: Record<string, AgmoLeaderNudgeRecord>;
  history: AgmoLeaderNudgeRecord[];
};
