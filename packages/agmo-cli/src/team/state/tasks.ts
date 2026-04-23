export type AgmoTeamTaskStatus =
  | "pending"
  | "blocked"
  | "in_progress"
  | "completed"
  | "failed";

export type AgmoTeamTaskRecord = {
  id: string;
  subject: string;
  description: string;
  owner?: string;
  role?: string;
  status: AgmoTeamTaskStatus;
  depends_on?: string[];
  blocked_by_dependencies?: Array<{
    task_id: string;
    status: AgmoTeamTaskStatus | "missing";
    reason: "dependency_not_completed" | "dependency_failed" | "dependency_missing";
  }>;
  requires_code_change?: boolean;
  claim?: {
    owner: string;
    claimed_at: string;
  };
  claim_history?: Array<{
    owner: string;
    claimed_at: string;
    released_at: string;
    release_reason: string;
    successor_owner?: string;
  }>;
  assignment_history?: Array<{
    owner?: string;
    assigned_at: string;
    reason: string;
  }>;
  result?: string;
  error?: string;
  version: number;
  created_at: string;
  updated_at: string;
};
