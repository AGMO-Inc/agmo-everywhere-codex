import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { inspectAgentsContent } from "../agents/agents-md.js";
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

export async function runDoctorCommand(args: string[]): Promise<void> {
  const scope = parseScopeFlag(args);
  const paths = resolveInstallPaths(scope);
  const projectRoot = resolveRuntimeRoot();
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
