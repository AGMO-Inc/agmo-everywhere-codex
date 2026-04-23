export type AgmoIntegrationStrategy = "cherry-pick" | "squash";
export type AgmoIntegrationConflictPolicy = "continue" | "stop";
export type AgmoIntegrationEmptyPolicy = "skip" | "fail";
export type AgmoIntegrationBatchOrder = "oldest" | "newest" | "task-id";
export type AgmoIntegrationTargetSource = "current" | "base" | "explicit";
export type AgmoTeamIntegrationAttemptStatus =
  | "planned"
  | "integrated"
  | "skipped"
  | "failed"
  | "conflict";

export type AgmoTeamIntegrationAttempt = {
  attempt_id: string;
  task_id: string;
  worker_name: string;
  branch_name?: string;
  strategy: AgmoIntegrationStrategy;
  dry_run: boolean;
  batch_id?: string;
  batch_index?: number;
  batch_total?: number;
  status: AgmoTeamIntegrationAttemptStatus;
  reason?: string;
  commits: string[];
  applied_commits?: string[];
  skipped_commits?: string[];
  conflict_commit?: string;
  conflict_paths?: string[];
  created_commit?: string;
  assist_path?: string;
  requested_target_ref?: string;
  target_ref?: string;
  target_source?: AgmoIntegrationTargetSource;
  started_at: string;
  completed_at: string;
};

export type AgmoTeamIntegrationState = {
  updated_at: string;
  attempts: AgmoTeamIntegrationAttempt[];
};
