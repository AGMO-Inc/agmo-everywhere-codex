import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { inspectAgentsContent } from "../agents/agents-md.js";
import {
  collectCleanupInventory,
  type CleanupInventorySummary
} from "../cleanup/inventory.js";
import { createCleanupPlan, type CleanupPlanSummary } from "../cleanup/plan.js";
import { resolveLaunchPolicy } from "../config/runtime.js";
import { listLaunchWorkspaces } from "../launch/session-workspace.js";
import { inspectTeamWorktrees } from "../team/worktree.js";
import { parseScopeFlag } from "../utils/args.js";
import { readTextFileIfExists } from "../utils/fs.js";
import { machineJsonEnvelope, uniqueRecommendedActions } from "../utils/machine-json.js";
import { resolveInstallPaths, codexHomeDir, resolveRuntimeRoot } from "../utils/paths.js";
import { resolveVaultRoot } from "../vault/runtime.js";

function detectTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

type DoctorRecommendation = {
  severity: "info" | "warning";
  message: string;
  command?: string;
};

type DoctorDiskUsageCategory = {
  category: CleanupInventorySummary["categories"][number]["category"];
  bytes: number;
  entries: number;
  safe_cleanup_candidate_bytes: number;
  safe_cleanup_candidate_entries: number;
};

type DoctorDiskUsageLargestCategory = {
  category: CleanupInventorySummary["categories"][number]["category"];
  bytes: number;
  safe_cleanup_candidate_bytes: number;
};

type DoctorDiskUsageBase = {
  scope: "current_project";
  candidate_basis: "retention_policy_and_effective_caps";
  project_root: string;
  agmo_dir: string;
  note: string;
  effective_caps?: CleanupPlanSummary["effective_caps"];
  pressure?: CleanupPlanSummary["pressure"];
  categories: DoctorDiskUsageCategory[];
  largest_nonzero_categories: DoctorDiskUsageLargestCategory[];
  recommendations: DoctorRecommendation[];
  recommended_actions: string[];
};

export type DoctorDiskUsage =
  | (DoctorDiskUsageBase & {
      status: "ok";
      totals: {
        bytes: number;
        entries: number;
        safe_cleanup_candidate_bytes: number;
        safe_cleanup_candidate_entries: number;
        projected_bytes_after_safe_cleanup: number;
      };
    })
  | (DoctorDiskUsageBase & {
      status: "error";
      error: {
        message: string;
      };
      totals: null;
    });

export type DoctorDiskUsageDeps = {
  collectCleanupInventory(projectRoot: string): Promise<CleanupInventorySummary>;
  createCleanupPlan(projectRoot: string): Promise<CleanupPlanSummary>;
};

export const defaultDoctorDiskUsageDeps: DoctorDiskUsageDeps = {
  collectCleanupInventory,
  createCleanupPlan: (projectRoot) => createCleanupPlan(projectRoot)
};

const DOCTOR_DISK_USAGE_SCOPE_NOTE =
  "Doctor disk usage always measures the current project's .agmo directory; --scope changes setup/config diagnostics only.";

function compactErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().split(/\s+/).join(" ") || "unknown error";
}

function groupPlanCandidatesByCategory(
  plan: CleanupPlanSummary
): Map<CleanupInventorySummary["categories"][number]["category"], { bytes: number; entries: number }> {
  const groups = new Map<
    CleanupInventorySummary["categories"][number]["category"],
    { bytes: number; entries: number }
  >();

  for (const entry of plan.would_delete) {
    const current = groups.get(entry.category) ?? { bytes: 0, entries: 0 };
    current.bytes += entry.bytes;
    current.entries += 1;
    groups.set(entry.category, current);
  }

  return groups;
}

function diskUsageRecommendations(safeCleanupCandidateBytes: number): DoctorRecommendation[] {
  return [
    {
      severity: "info",
      message: "Inspect current project Agmo disk usage before cleanup.",
      command: "agmo cleanup inspect --json --verbose"
    },
    {
      severity: "info",
      message: "Plan safe retention-policy cleanup without deleting files.",
      command: "agmo cleanup plan --json --verbose"
    },
    ...(safeCleanupCandidateBytes > 0
      ? [
          {
            severity: "info" as const,
            message: "Run safe cleanup only after reviewing the plan; this command requires confirmation.",
            command: "agmo cleanup run --confirm --json"
          }
        ]
      : []),
    {
      severity: "info",
      message: "Optionally enable safe launch auto-cleanup for future launches.",
      command: "agmo config cleanup set safe_auto_cleanup_on_launch true --scope project"
    }
  ];
}

function errorDiskUsage(projectRoot: string, error: unknown): DoctorDiskUsage {
  const agmoDir = resolveInstallPaths("project", projectRoot).agmoDir;
  const recommendations: DoctorRecommendation[] = [
    {
      severity: "info",
      message:
        "Agmo disk usage could not be measured; other doctor checks still ran. Run cleanup inspect directly for details.",
      command: "agmo cleanup inspect --json --verbose"
    }
  ];

  return {
    status: "error",
    scope: "current_project",
    project_root: projectRoot,
    agmo_dir: agmoDir,
    candidate_basis: "retention_policy_and_effective_caps",
    note: DOCTOR_DISK_USAGE_SCOPE_NOTE,
    error: {
      message: compactErrorMessage(error)
    },
    totals: null,
    categories: [],
    largest_nonzero_categories: [],
    recommendations,
    recommended_actions: uniqueRecommendedActions(
      recommendations.map((recommendation) => recommendation.command)
    )
  };
}

export async function buildDoctorDiskUsage(
  projectRoot: string,
  deps: DoctorDiskUsageDeps = defaultDoctorDiskUsageDeps
): Promise<DoctorDiskUsage> {
  try {
    const inventory = await deps.collectCleanupInventory(projectRoot);
    const plan = await deps.createCleanupPlan(projectRoot);
    const candidatesByCategory = groupPlanCandidatesByCategory(plan);
    const categories = inventory.categories.map((category) => {
      const candidate = candidatesByCategory.get(category.category) ?? { bytes: 0, entries: 0 };
      return {
        category: category.category,
        bytes: category.bytes,
        entries: category.entries,
        safe_cleanup_candidate_bytes: candidate.bytes,
        safe_cleanup_candidate_entries: candidate.entries
      };
    });
    const largestNonzeroCategories = [...categories]
      .filter((category) => category.bytes > 0)
      .sort((left, right) => right.bytes - left.bytes || left.category.localeCompare(right.category))
      .slice(0, 5)
      .map((category) => ({
        category: category.category,
        bytes: category.bytes,
        safe_cleanup_candidate_bytes: category.safe_cleanup_candidate_bytes
      }));
    const recommendations = diskUsageRecommendations(plan.totals.would_delete_bytes);

    return {
      status: "ok",
      scope: "current_project",
      project_root: inventory.project_root,
      agmo_dir: inventory.agmo_dir,
      candidate_basis: "retention_policy_and_effective_caps",
      note: DOCTOR_DISK_USAGE_SCOPE_NOTE,
      effective_caps: plan.effective_caps,
      pressure: plan.pressure,
      totals: {
        bytes: inventory.totals.bytes,
        entries: inventory.totals.entries,
        safe_cleanup_candidate_bytes: plan.totals.would_delete_bytes,
        safe_cleanup_candidate_entries: plan.totals.would_delete_entries,
        projected_bytes_after_safe_cleanup: Math.max(
          inventory.totals.bytes - plan.totals.would_delete_bytes,
          0
        )
      },
      categories,
      largest_nonzero_categories: largestNonzeroCategories,
      recommendations,
      recommended_actions: uniqueRecommendedActions(
        recommendations.map((recommendation) => recommendation.command)
      )
    };
  } catch (error) {
    return errorDiskUsage(projectRoot, error);
  }
}

export async function runDoctorCommand(args: string[]): Promise<void> {
  const scope = parseScopeFlag(args);
  const paths = resolveInstallPaths(scope);
  const projectRoot = resolveRuntimeRoot();
  const diskUsage = await buildDoctorDiskUsage(projectRoot);
  const tmuxAvailable = detectTmux();
  const agentsMdContent = await readTextFileIfExists(paths.agentsMdFile);
  const scopedAgentsInspection = inspectAgentsContent(agentsMdContent);
  const launchPolicy = await resolveLaunchPolicy(projectRoot);
  const vault = await resolveVaultRoot(projectRoot);
  const launchWorkspaces = await listLaunchWorkspaces({
    projectRoot
  });
  const teamWorktrees = await inspectTeamWorktrees(projectRoot);
  const setupRecommendations: DoctorRecommendation[] = [];
  const vaultRecommendations: DoctorRecommendation[] = [];
  const teamRecommendations: DoctorRecommendation[] = [];
  const launchWorkspaceSummary = launchWorkspaces.reduce(
    (summary, workspace) => {
      summary.count += 1;

      if (workspace.derived.state === "active") {
        summary.active += 1;
      } else if (workspace.derived.state === "stale") {
        summary.stale += 1;
      } else if (workspace.derived.state === "inactive") {
        summary.inactive += 1;
      } else {
        summary.unknown += 1;
      }

      return summary;
    },
    {
      count: 0,
      active: 0,
      stale: 0,
      inactive: 0,
      unknown: 0
    }
  );
  const launchWorkspaceRecommendations: DoctorRecommendation[] = [];
  const teamWorktreeRecommendations: DoctorRecommendation[] = [];
  const setupCommand = `agmo setup --scope ${scope}`;

  if (
    !existsSync(paths.codexDir) ||
    !existsSync(paths.agentsDir) ||
    !existsSync(paths.hooksFile) ||
    !existsSync(paths.agmoDir) ||
    !existsSync(paths.stateDir)
  ) {
    setupRecommendations.push({
      severity: "warning",
      message: `Agmo runtime files are incomplete for ${scope} scope.`,
      command: setupCommand
    });
  }

  if (!existsSync(paths.agentsMdFile)) {
    setupRecommendations.push({
      severity: "info",
      message: "AGENTS.md is missing for this scope.",
      command: setupCommand
    });
  } else if (!scopedAgentsInspection.managed && !scopedAgentsInspection.legacy_generated) {
    setupRecommendations.push({
      severity: "warning",
      message:
        "AGENTS.md exists but is not Agmo-managed; rerun setup with --force only if you want Agmo to adopt it.",
      command: `${setupCommand} --force`
    });
  }

  if (vault.vault_root === null) {
    vaultRecommendations.push({
      severity: "info",
      message: "No vault root is configured; durable notes and saved artifacts stay unavailable.",
      command: `agmo config vault set-root <path> --scope ${scope}`
    });
  } else if (!existsSync(vault.vault_root)) {
    vaultRecommendations.push({
      severity: "warning",
      message: `Configured vault root does not exist: ${vault.vault_root}`
    });
  }

  if (!tmuxAvailable) {
    teamRecommendations.push({
      severity: "warning",
      message: "tmux is unavailable; Agmo team runtime commands will stay unavailable."
    });
  }

  if (launchWorkspaceSummary.stale > 0) {
    launchWorkspaceRecommendations.push(
      {
        severity: "warning",
        message: `Found ${launchWorkspaceSummary.stale} stale launch workspace(s).`,
        command: "agmo launch cleanup --stale"
      }
    );
  }

  if (
    launchWorkspaceSummary.inactive > 0 &&
    launchWorkspaceSummary.active === 0 &&
    launchWorkspaceSummary.stale === 0
  ) {
    launchWorkspaceRecommendations.push(
      {
        severity: "info",
        message: "Only inactive launch workspaces remain.",
        command: "agmo launch cleanup --older-than-hours 0"
      }
    );
  }

  if (launchWorkspaceSummary.active > 0) {
    launchWorkspaceRecommendations.push(
      {
        severity: "info",
        message: `Found ${launchWorkspaceSummary.active} active launch workspace(s); discard them only intentionally.`,
        command: "agmo launch cleanup --all --include-active"
      }
    );
  }

  if (teamWorktrees.counts.missing_manifest > 0) {
    teamWorktreeRecommendations.push({
      severity: "warning",
      message: `Found ${teamWorktrees.counts.missing_manifest} orphaned Agmo worktree directories without ownership manifests; inspect them manually before deleting.`,
      command: "find .agmo/worktrees -mindepth 1 -maxdepth 2 -print"
    });
  }

  if (teamWorktrees.counts.invalid_manifest > 0) {
    teamWorktreeRecommendations.push({
      severity: "warning",
      message: `Found ${teamWorktrees.counts.invalid_manifest} invalid Agmo worktree manifest(s); review durable ownership evidence before cleanup.`,
      command: "find .agmo/worktrees -name manifest.json -print"
    });
  }

  if (teamWorktrees.counts.dirty_worker > 0) {
    teamWorktreeRecommendations.push({
      severity: "warning",
      message: `Found ${teamWorktrees.counts.dirty_worker} dirty Agmo worker worktree(s); inspect git status before cleanup.`,
      command: "git -C <worker-path> status --short"
    });
  }

  if (teamWorktrees.counts.worker_path_not_git_worktree > 0) {
    teamWorktreeRecommendations.push({
      severity: "warning",
      message: `Found ${teamWorktrees.counts.worker_path_not_git_worktree} manifest worker path(s) that are not git worktrees; manual review is required.`
    });
  }

  if (teamWorktrees.counts.worker_path_missing > 0) {
    teamWorktreeRecommendations.push({
      severity: "info",
      message: `Found ${teamWorktrees.counts.worker_path_missing} manifest worker path(s) already missing.`
    });
  }

  if (teamWorktrees.counts.safe_to_delete_candidates > 0) {
    teamWorktreeRecommendations.push({
      severity: "info",
      message: `Found ${teamWorktrees.counts.safe_to_delete_candidates} manifest-owned clean Agmo worktree set(s) that are cleanup candidates.`,
      command: "agmo team delete <team> --dry-run --remove-worktrees"
    });
  }

  const recommendations = {
    setup: setupRecommendations,
    vault: vaultRecommendations,
    team: teamRecommendations,
    launch_workspaces: launchWorkspaceRecommendations,
    team_worktrees: teamWorktreeRecommendations
  };
  const allRecommendations = Object.values(recommendations).flat();
  const ok = allRecommendations.every((recommendation) => recommendation.severity !== "warning");
  const recommendedActions = uniqueRecommendedActions(
    allRecommendations.map((recommendation) => recommendation.command)
  );

  console.log(
    JSON.stringify(
      machineJsonEnvelope("doctor", ok, {
        command: "doctor",
        scope,
        checks: {
          codex_home_exists: existsSync(codexHomeDir()),
          codex_dir_exists: existsSync(paths.codexDir),
          agents_dir_exists: existsSync(paths.agentsDir),
          hooks_file_exists: existsSync(paths.hooksFile),
          agents_md_exists: existsSync(paths.agentsMdFile),
          agmo_dir_exists: existsSync(paths.agmoDir),
          agmo_state_exists: existsSync(paths.stateDir),
          session_instructions_dir_exists: existsSync(paths.sessionInstructionsDir),
          launch_workspace_cache_exists: existsSync(join(paths.cacheDir, "launch-workspaces")),
          tmux_available: tmuxAvailable
        },
        agents_md: scopedAgentsInspection,
        vault: {
          ...vault,
          exists: vault.vault_root ? existsSync(vault.vault_root) : false
        },
        launch_policy: {
          ...launchPolicy.policy,
          sources: launchPolicy.sources
        },
        launch_workspaces: launchWorkspaceSummary,
        team_worktrees: teamWorktrees,
        disk_usage: diskUsage,
        recommendations,
        recommended_actions: recommendedActions,
        paths: {
          codex_home: codexHomeDir(),
          codex_dir: paths.codexDir,
          hooks_file: paths.hooksFile,
          agents_md_file: paths.agentsMdFile,
          agmo_dir: paths.agmoDir,
          session_instructions_dir: paths.sessionInstructionsDir,
          launch_workspace_cache_dir: join(paths.cacheDir, "launch-workspaces")
        }
      }),
      null,
      2
    )
  );
}
