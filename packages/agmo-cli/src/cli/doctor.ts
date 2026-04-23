import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { inspectAgentsContent } from "../agents/agents-md.js";
import { resolveLaunchPolicy } from "../config/runtime.js";
import { listLaunchWorkspaces } from "../launch/session-workspace.js";
import { parseScopeFlag } from "../utils/args.js";
import { readTextFileIfExists } from "../utils/fs.js";
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


  console.log(
    JSON.stringify(
      {
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
        recommendations: {
          setup: setupRecommendations,
          vault: vaultRecommendations,
          team: teamRecommendations,
          launch_workspaces: launchWorkspaceRecommendations
        },
        paths: {
          codex_home: codexHomeDir(),
          codex_dir: paths.codexDir,
          hooks_file: paths.hooksFile,
          agents_md_file: paths.agentsMdFile,
          agmo_dir: paths.agmoDir,
          session_instructions_dir: paths.sessionInstructionsDir,
          launch_workspace_cache_dir: join(paths.cacheDir, "launch-workspaces")
        }
      },
      null,
      2
    )
  );
}
