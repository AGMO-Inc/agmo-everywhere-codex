import { readdir } from "node:fs/promises";
import { relative } from "node:path";
import { writeSessionComposedAgentsFile } from "../agents/agents-md.js";
import { AGMO_AGENT_DEFINITIONS } from "../agents/definitions.js";
import {
  resolveLaunchPolicy,
  resolveSessionStartPolicy
} from "../config/runtime.js";
import { readOptionalSessionId, type AgmoHookPayload } from "./runtime-state.js";
import { readTextFileIfExists } from "../utils/fs.js";
import { resolveInstallPaths, resolveRuntimeRoot } from "../utils/paths.js";
import { resolveVaultRoot } from "../vault/runtime.js";
import { readEffectiveWisdom, type AgmoEffectiveWisdomSummary } from "../wisdom/store.js";

type JsonRecord = Record<string, unknown>;

type WorkflowSummary = {
  name: string;
  status: string;
};

type TeamSummary = {
  name: string;
  task: string;
  workerCount: number;
  phase: string;
  currentSession: boolean;
};

async function readJsonFile(path: string): Promise<JsonRecord | null> {
  const content = await readTextFileIfExists(path);
  if (!content) {
    return null;
  }

  try {
    return JSON.parse(content) as JsonRecord;
  } catch {
    return null;
  }
}

function formatPath(path: string, cwd: string): string {
  const relativePath = relative(cwd, path);
  if (!relativePath || relativePath.startsWith("..")) {
    return path;
  }

  return relativePath;
}

function resolveWorkflowStatus(record: JsonRecord): string {
  const statusCandidates = [
    record.current_phase,
    record.status,
    record.run_outcome,
    record.lifecycle_outcome,
    record.terminal_outcome
  ];

  const status = statusCandidates.find(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );

  if (status) {
    return status;
  }

  if (record.active === true) {
    return "active";
  }

  if (record.active === false) {
    return "inactive";
  }

  return "unknown";
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isStaleWorkflowSnapshot(record: JsonRecord, staleAfterMs: number, now = Date.now()): boolean {
  if (resolveWorkflowStatus(record) !== "active") {
    return false;
  }

  const referenceAtMs =
    parseTimestampMs(record.updated_at) ??
    parseTimestampMs(record.completed_at) ??
    parseTimestampMs(record.started_at);
  if (referenceAtMs === null) {
    return false;
  }

  return now - referenceAtMs > staleAfterMs;
}

async function listWorkflowSummaries(
  runtimeRoot: string,
  staleAfterMs: number
): Promise<WorkflowSummary[]> {
  const { workflowsStateDir } = resolveInstallPaths("project", runtimeRoot);

  try {
    const entries = await readdir(workflowsStateDir, { withFileTypes: true });
    const workflowFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();

    const summaries = await Promise.all(
      workflowFiles.map(async (fileName) => {
        const record = await readJsonFile(`${workflowsStateDir}/${fileName}`);
        const status = record ? resolveWorkflowStatus(record) : "unknown";

        if (record && isStaleWorkflowSnapshot(record, staleAfterMs)) {
          return null;
        }

        return {
          name:
            (record && typeof record.workflow === "string" && record.workflow.trim()) ||
            fileName.replace(/\.json$/u, ""),
          status
        };
      })
    );

    return summaries.filter(
      (summary): summary is WorkflowSummary =>
        summary !== null && summary.status !== "inactive"
    );
  } catch {
    return [];
  }
}

async function listActiveTeams(
  runtimeRoot: string,
  currentSessionId: string | null
): Promise<TeamSummary[]> {
  const { teamStateDir } = resolveInstallPaths("project", runtimeRoot);

  try {
    const entries = await readdir(teamStateDir, { withFileTypes: true });
    const teamDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

    const summaries = await Promise.all(
      teamDirs.map(async (teamName) => {
        const config = await readJsonFile(`${teamStateDir}/${teamName}/config.json`);
        const phase = await readJsonFile(`${teamStateDir}/${teamName}/phase.json`);

        const isActive =
          config?.active === true ||
          phase?.active === true ||
          phase?.current_phase === "active";

        if (!isActive) {
          return null;
        }

        return {
          name: teamName,
          task: typeof config?.task === "string" ? config.task : "unknown task",
          workerCount:
            typeof config?.worker_count === "number" ? config.worker_count : 0,
          currentSession:
            Boolean(currentSessionId) &&
            typeof config?.session_id === "string" &&
            config.session_id.trim() === currentSessionId,
          phase:
            typeof phase?.current_phase === "string"
              ? phase.current_phase
              : typeof config?.phase === "string"
                ? config.phase
                : "active"
        } satisfies TeamSummary;
      })
    );

    return summaries.filter((summary): summary is TeamSummary => summary !== null);
  } catch {
    return [];
  }
}

function formatWorkflowLine(workflows: WorkflowSummary[]): string {
  if (workflows.length === 0) {
    return "- Workflow state: no active workflow snapshots detected.";
  }

  return `- Workflow state: ${workflows
    .map((workflow) => `${workflow.name} (${workflow.status})`)
    .join(", ")}`;
}

function formatTeamLine(
  teams: TeamSummary[],
  env: NodeJS.ProcessEnv,
  currentSessionId: string | null
): string {
  const currentTeam = env.AGMO_TEAM_NAME?.trim();
  const currentWorker = env.AGMO_WORKER_NAME?.trim();
  const currentRole = env.AGMO_WORKER_ROLE?.trim();
  const currentTeamSnapshot =
    (currentTeam && teams.find((team) => team.name === currentTeam)) || null;
  const currentSessionTeams = teams.filter(
    (team) => team.currentSession && team.name !== currentTeam
  );
  const hiddenOtherTeams = teams.length - currentSessionTeams.length - (currentTeamSnapshot ? 1 : 0);
  const formatTeamPreview = (team: TeamSummary): string =>
    `${team.name} [${team.phase}, workers=${team.workerCount}]`;
  const formatTeamPreviewList = (entries: TeamSummary[]): string => {
    const preview = entries
      .slice(0, 3)
      .map((team) => formatTeamPreview(team))
      .join(", ");
    const remainder = entries.length > 3 ? `, +${entries.length - 3} more` : "";
    return `${preview}${remainder}`;
  };

  if (currentTeam && currentWorker) {
    const roleSuffix = currentRole ? ` (${currentRole})` : "";
    const suffixes = [
      currentSessionTeams.length > 0
        ? `related session teams: ${formatTeamPreviewList(currentSessionTeams)}`
        : null,
      hiddenOtherTeams > 0
        ? `${hiddenOtherTeams} unrelated active team snapshot${hiddenOtherTeams === 1 ? "" : "s"} hidden`
        : null
    ].filter((value): value is string => Boolean(value));

    return `- Team session: ${currentTeam}/${currentWorker}${roleSuffix}${suffixes.length > 0 ? `; ${suffixes.join("; ")}` : ""}.`;
  }

  if (teams.length === 0) {
    return "- Team session: none active.";
  }

  if (currentTeamSnapshot) {
    const suffixes = [
      `current team: ${formatTeamPreview(currentTeamSnapshot)}`,
      currentSessionTeams.length > 0
        ? `related session teams: ${formatTeamPreviewList(currentSessionTeams)}`
        : null,
      hiddenOtherTeams > 0
        ? `${hiddenOtherTeams} unrelated active team snapshot${hiddenOtherTeams === 1 ? "" : "s"} hidden`
        : null
    ].filter((value): value is string => Boolean(value));

    return `- Team session: no current worker session; ${suffixes.join("; ")}.`;
  }

  if (currentSessionTeams.length > 0) {
    const hiddenSuffix =
      hiddenOtherTeams > 0
        ? `; ${hiddenOtherTeams} unrelated active team snapshot${hiddenOtherTeams === 1 ? "" : "s"} hidden`
        : "";

    return `- Team session: current-session team snapshots: ${formatTeamPreviewList(currentSessionTeams)}${hiddenSuffix}.`;
  }

  const currentSessionSuffix = currentSessionId ? " from other/older sessions" : "";
  return `- Team session: no current worker session; ${teams.length} active team snapshots${currentSessionSuffix} hidden.`;
}

function formatCompactTeamSummary(teams: TeamSummary[], currentSessionId: string | null): string {
  if (teams.length === 0) {
    return "teams=none";
  }

  const currentSessionTeams = teams.filter((team) => team.currentSession);
  if (currentSessionTeams.length > 0) {
    return `teams=current-session:${currentSessionTeams.length}/active:${teams.length}`;
  }

  return currentSessionId
    ? `teams=hidden-other-sessions:${teams.length}`
    : `teams=active:${teams.length}`;
}

function formatWisdomLine(
  vault: Awaited<ReturnType<typeof resolveVaultRoot>>,
  runtimeRoot: string
): string {
  if (!vault.vault_root) {
    return "- Wisdom: vault root not configured yet; use `agmo vault config set-root <path>`.";
  }

  return `- Wisdom: vault ready at ${formatPath(vault.vault_root, runtimeRoot)} (${vault.source}).`;
}

function excerptWisdomContent(value: string): string {
  return value.length > 96 ? `${value.slice(0, 93)}...` : value;
}

function formatWisdomMemoryLines(summary: AgmoEffectiveWisdomSummary): string[] {
  if (summary.merged.length === 0) {
    return ["- Wisdom memory: no Agmo-native learn/decision/issue entries yet."];
  }

  const lines = [
    `- Wisdom memory: loaded ${summary.merged.length} entries (global=${summary.user.entries.length}, project=${summary.project.entries.length}).`
  ];

  for (const kind of ["decision", "issue", "learn"] as const) {
    const scopedEntries = [
      ...summary.project.entries
        .filter((entry) => entry.kind === kind)
        .slice(0, 1)
        .map((entry) => `[project] ${excerptWisdomContent(entry.content)}`),
      ...summary.user.entries
        .filter((entry) => entry.kind === kind)
        .slice(0, 1)
        .map((entry) => `[global] ${excerptWisdomContent(entry.content)}`)
    ];

    if (scopedEntries.length > 0) {
      lines.push(`  - ${kind}s: ${scopedEntries.join("; ")}`);
    }
  }

  return lines;
}

function formatLaunchPolicyLine(
  policy: Awaited<ReturnType<typeof resolveLaunchPolicy>>["policy"]
): string {
  return `- Launch policy: cleanup>${policy.default_cleanup_older_than_hours}h prunes by default; heartbeat every ${policy.heartbeat_interval_ms}ms; stale after ${policy.heartbeat_stale_after_ms}ms.`;
}

function parseOptionalBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }

  return null;
}

function formatCompactStatusLine(args: {
  workflows: WorkflowSummary[];
  teams: TeamSummary[];
  vault: Awaited<ReturnType<typeof resolveVaultRoot>>;
  currentSessionId: string | null;
  wisdom: AgmoEffectiveWisdomSummary;
}): string {
  const workflowSummary =
    args.workflows.length === 0
      ? "workflows=none"
      : `workflows=${args.workflows.length}`;
  const teamSummary = formatCompactTeamSummary(args.teams, args.currentSessionId);
  const vaultSummary = args.vault.vault_root ? "vault=ready" : "vault=unconfigured";
  const wisdomSummary =
    args.wisdom.merged.length === 0
      ? "wisdom=none"
      : `wisdom=global:${args.wisdom.user.entries.length}/project:${args.wisdom.project.entries.length}`;

  return `- Status: ${workflowSummary}; ${teamSummary}; ${vaultSummary}; ${wisdomSummary}.`;
}

function resolveSessionStartMode(
  env: NodeJS.ProcessEnv,
  payload: AgmoHookPayload | undefined,
  defaultMode: "compact" | "full" | "debug"
): "compact" | "full" | "debug" {
  const candidates = [
    env.AGMO_SESSION_START_MODE,
    typeof payload?.session_start_mode === "string"
      ? payload.session_start_mode
      : null,
    typeof payload?.sessionStartMode === "string"
      ? payload.sessionStartMode
      : null
  ];

  for (const candidate of candidates) {
    if (candidate === "compact" || candidate === "full" || candidate === "debug") {
      return candidate;
    }
  }

  return defaultMode;
}

function resolveShowLaunchPolicySource(
  env: NodeJS.ProcessEnv,
  payload: AgmoHookPayload | undefined,
  defaultValue: boolean
): boolean {
  const candidates = [
    parseOptionalBoolean(env.AGMO_SESSION_START_SHOW_LAUNCH_POLICY_SOURCE),
    parseOptionalBoolean(payload?.show_launch_policy_source),
    parseOptionalBoolean(payload?.showLaunchPolicySource)
  ];

  for (const candidate of candidates) {
    if (candidate !== null) {
      return candidate;
    }
  }

  return defaultValue;
}

function resolveCurrentTeamSessionId(
  env: NodeJS.ProcessEnv,
  payload: AgmoHookPayload | undefined
): string | null {
  const candidates = [
    env.AGMO_LAUNCH_SESSION_ID,
    payload ? readOptionalSessionId(payload) : null
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function formatLaunchPolicySourceLine(
  sources: Awaited<ReturnType<typeof resolveLaunchPolicy>>["sources"]["effective"]
): string {
  return `- Launch policy source: cleanup=${sources.default_cleanup_older_than_hours}; heartbeat_interval=${sources.heartbeat_interval_ms}; stale_after=${sources.heartbeat_stale_after_ms}.`;
}

function formatDebugLines(args: {
  runtimeRoot: string;
  env: NodeJS.ProcessEnv;
  payload?: AgmoHookPayload;
  vault: Awaited<ReturnType<typeof resolveVaultRoot>>;
  launchPolicy: Awaited<ReturnType<typeof resolveLaunchPolicy>>;
  sessionStartPolicy: Awaited<ReturnType<typeof resolveSessionStartPolicy>>;
}): string[] {
  return [
    `- Debug: session_id=${args.payload ? readOptionalSessionId(args.payload) ?? "none" : "none"}; launch_workspace=${args.env.AGMO_LAUNCH_WORKSPACE_ROOT?.trim() || "none"}.`,
    `- Debug: vault source=${args.vault.source}; checked_paths=${args.vault.checked_paths.map((path) => formatPath(path, args.runtimeRoot)).join(", ") || "none"}.`,
    `- Debug: launch config paths: project=${formatPath(args.launchPolicy.sources.project_config_path, args.runtimeRoot)}; user=${formatPath(args.launchPolicy.sources.user_config_path, args.runtimeRoot)}.`,
    `- Debug: session-start config paths: project=${formatPath(args.sessionStartPolicy.sources.project_config_path, args.runtimeRoot)}; user=${formatPath(args.sessionStartPolicy.sources.user_config_path, args.runtimeRoot)}.`,
    `- Debug: session-start policy source: mode=${args.sessionStartPolicy.sources.effective.mode}; show_launch_policy_source=${args.sessionStartPolicy.sources.effective.show_launch_policy_source}.`
  ];
}

async function formatSessionInstructionsLine(args: {
  runtimeRoot: string;
  payload?: AgmoHookPayload;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  const launchWorkspaceRoot = args.env.AGMO_LAUNCH_WORKSPACE_ROOT?.trim();
  if (launchWorkspaceRoot) {
    return `- Session AGENTS: ${formatPath(launchWorkspaceRoot + "/AGENTS.md", args.runtimeRoot)} (launch workspace root).`;
  }

  const sessionId = args.payload ? readOptionalSessionId(args.payload) : null;

  if (!sessionId) {
    return "- Session AGENTS: no session id provided; using project/user AGENTS directly.";
  }

  const result = await writeSessionComposedAgentsFile({
    cwd: args.runtimeRoot,
    sessionId
  });

  const sourceLabels = [
    result.sources.user_agents_md ? "user" : null,
    result.sources.project_agents_md ? "project" : null
  ].filter((value): value is string => Boolean(value));

  const sourceSummary =
    sourceLabels.length > 0 ? `${sourceLabels.join(" + ")} composed` : "overlay-only";

  return `- Session AGENTS: ${formatPath(result.path, args.runtimeRoot)} (${sourceSummary}, ${result.status}).`;
}

export async function buildSessionStartContext(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  payload?: AgmoHookPayload
): Promise<string> {
  const runtimeRoot = resolveRuntimeRoot(cwd);
  const currentSessionId = resolveCurrentTeamSessionId(env, payload);
  const launchPolicy = await resolveLaunchPolicy(runtimeRoot);
  const workflows = await listWorkflowSummaries(
    runtimeRoot,
    launchPolicy.policy.heartbeat_stale_after_ms
  );
  const activeTeams = await listActiveTeams(runtimeRoot, currentSessionId);
  const vault = await resolveVaultRoot(runtimeRoot);
  const wisdom = await readEffectiveWisdom(runtimeRoot);
  const sessionStartPolicy = await resolveSessionStartPolicy(runtimeRoot);
  const sessionInstructionsLine = await formatSessionInstructionsLine({
    runtimeRoot,
    payload,
    env
  });
  const mode = resolveSessionStartMode(
    env,
    payload,
    sessionStartPolicy.policy.mode
  );
  const showLaunchPolicySource = resolveShowLaunchPolicySource(
    env,
    payload,
    sessionStartPolicy.policy.show_launch_policy_source
  );

  if (mode === "compact") {
    return [
      "Agmo session bootstrap active.",
      `- Runtime root: ${runtimeRoot}`,
      sessionInstructionsLine,
      formatLaunchPolicyLine(launchPolicy.policy),
      ...(showLaunchPolicySource
        ? [formatLaunchPolicySourceLine(launchPolicy.sources.effective)]
        : []),
      formatCompactStatusLine({
        workflows,
        teams: activeTeams,
        vault,
        currentSessionId,
        wisdom
      })
    ].join("\n");
  }

  const fullLines = [
    "Agmo session bootstrap active.",
    `- Runtime root: ${runtimeRoot}`,
    `- Native roles: ${AGMO_AGENT_DEFINITIONS.map((agent) => agent.name).join(", ")}`,
    sessionInstructionsLine,
    formatLaunchPolicyLine(launchPolicy.policy),
    ...(showLaunchPolicySource
      ? [formatLaunchPolicySourceLine(launchPolicy.sources.effective)]
      : []),
    formatWisdomLine(vault, runtimeRoot),
    ...formatWisdomMemoryLines(wisdom),
    formatWorkflowLine(workflows),
    formatTeamLine(activeTeams, env, currentSessionId)
  ];

  if (mode === "debug") {
    fullLines.push(
      ...formatDebugLines({
        runtimeRoot,
        env,
        payload,
        vault,
        launchPolicy,
        sessionStartPolicy
      })
    );
  }

  return fullLines.join("\n");
}
