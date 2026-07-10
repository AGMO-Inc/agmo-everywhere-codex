import { spawn } from "node:child_process";
import { basename } from "node:path";
import { createCleanupPlan, type CleanupPlanEntry, type CleanupPlanSummary } from "../cleanup/plan.js";
import { runCleanupPlan, type CleanupRunSummary } from "../cleanup/run.js";
import {
  readScopedAgmoConfig,
  resolveCleanupPolicy,
  resetLaunchPolicy,
  resolveLaunchPolicy,
  setLaunchPolicyValue,
  unsetLaunchPolicyValue
} from "../config/runtime.js";
import {
  cleanupLaunchWorkspaces,
  listLaunchWorkspaces,
  prepareSessionWorkspace,
  recordLaunchWorkspaceHeartbeat,
  recordLaunchWorkspaceStarted,
  recordLaunchWorkspaceExit
} from "../launch/session-workspace.js";
import { currentTmuxPaneId, isTmuxAvailable } from "../team/tmux-session.js";
import { agmoCliDistEntryPath, resolveRuntimeRoot } from "../utils/paths.js";
import { parseScopeFlag } from "../utils/args.js";
import { ensureCodexCliArgs, normalizeCodexAutonomyMode, type CodexAutonomyMode } from "../utils/codex.js";

const AGMO_TMUX_BOOTSTRAPPED_ENV = "AGMO_TMUX_BOOTSTRAPPED";
const AGMO_CODEX_AUTONOMY_MODE_ENV = "AGMO_CODEX_AUTONOMY_MODE";
const AUTO_CLEANUP_LAUNCH_REASON = "inactive clean launch workspace older than retention threshold";
const AUTO_CLEANUP_SESSION_OLD_REASON = "session instructions older than retention threshold";
const AUTO_CLEANUP_SESSION_NEW_REASON = "session instructions newer than retention threshold";
const AUTO_CLEANUP_PAIRED_REASON =
  "paired with expired clean launch workspace during opt-in launch auto-cleanup";

type CleanupPolicyResult = Awaited<ReturnType<typeof resolveCleanupPolicy>>;
type CleanupPlanResult = CleanupPlanSummary;

export type LaunchAutoCleanupDeps = {
  resolveCleanupPolicy?: (projectRoot: string) => Promise<CleanupPolicyResult>;
  createCleanupPlan?: (projectRoot: string) => Promise<CleanupPlanResult>;
  runCleanupPlan?: (plan: CleanupPlanResult) => Promise<CleanupRunSummary>;
  writeStderr?: (message: string) => void;
};

const defaultLaunchAutoCleanupDeps: Required<LaunchAutoCleanupDeps> = {
  resolveCleanupPolicy,
  createCleanupPlan,
  runCleanupPlan,
  writeStderr: (message) => process.stderr.write(message)
};

function printLaunchHelp(): void {
  console.log(`Usage:
  agmo launch [codex args...]
  agmo launch [--tmux|--no-tmux] [codex args...]
  agmo launch config show [--scope user|project]
  agmo launch config set <key> <value> [--scope user|project]
  agmo launch config unset <key> [--scope user|project]
  agmo launch config reset [--scope user|project]
  agmo launch list [--summary|--verbose]
  agmo launch cleanup [--all] [--older-than-hours <n>] [--include-active] [--stale]

Launch Codex from an Agmo session workspace shadow root so the main session
uses a session-scoped AGENTS.md inside a session-local Git sandbox while keeping runtime state anchored to the
real project root.

Notes:
  --tmux forces leader launch inside tmux when available.
  --tmux requires an interactive TTY because Agmo attaches the leader to a live tmux session.
  --no-tmux disables auto-tmux leader launch.
  --summary and --verbose are mutually exclusive.
  --include-active is only valid together with --all.

Examples:
  agmo launch
  agmo launch --tmux
  agmo launch --madmax
  agmo launch --no-tmux --full-auto
  agmo launch --full-auto
  agmo launch debug prompt-input "hello"
  agmo launch config show
  agmo launch config show --scope project
  agmo launch config set autonomy_mode madmax --scope project
  agmo launch config set heartbeat_interval_ms 45000 --scope project
  agmo launch config unset heartbeat_interval_ms --scope project
  agmo launch config reset --scope project
  agmo launch list
  agmo launch list --summary
  agmo launch list --verbose
  agmo launch cleanup
  agmo launch cleanup --stale
  agmo launch cleanup --stale --older-than-hours 6
  agmo launch cleanup --older-than-hours 6
  agmo launch cleanup --all
  agmo launch cleanup --all --include-active
`);
}

function summarizeLaunchWorkspaces(
  workspaces: Awaited<ReturnType<typeof listLaunchWorkspaces>>
): {
  count: number;
  active: number;
  stale: number;
  inactive: number;
  unknown: number;
} {
  return workspaces.reduce(
    (counts, workspace) => {
      counts.count += 1;

      if (workspace.derived.state === "active") {
        counts.active += 1;
      } else if (workspace.derived.state === "stale") {
        counts.stale += 1;
      } else if (workspace.derived.state === "inactive") {
        counts.inactive += 1;
      } else {
        counts.unknown += 1;
      }

      return counts;
    },
    {
      count: 0,
      active: 0,
      stale: 0,
      inactive: 0,
      unknown: 0
    }
  );
}

function parseOption(args: string[], optionName: string): string | undefined {
  const exactIndex = args.findIndex((arg) => arg === optionName);
  if (exactIndex >= 0) {
    return args[exactIndex + 1];
  }

  const inline = args.find((arg) => arg.startsWith(`${optionName}=`));
  return inline ? inline.slice(optionName.length + 1) : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function removeFlag(args: string[], flag: string): string[] {
  return args.filter((arg) => arg !== flag);
}

function resolveLaunchTmuxMode(args: string[]): {
  mode: "auto" | "force" | "disabled";
  codexArgs: string[];
  explicitAutonomyMode: CodexAutonomyMode | null;
} {
  const forceTmux = args.includes("--tmux");
  const disableTmux = args.includes("--no-tmux");
  const launchArgs = removeFlag(removeFlag(args, "--tmux"), "--no-tmux");
  const explicitAutonomyMode = launchArgs.includes("--madmax")
    || launchArgs.includes("--dangerously-bypass-approvals-and-sandbox")
    ? "madmax"
    : launchArgs.includes("--full-auto") || launchArgs.includes("--yolo")
      ? "full-auto"
      : null;

  assertNoConflictingFlags({
    selected: [forceTmux, disableTmux],
    message: "--tmux and --no-tmux cannot be used together"
  });

  return {
    mode: forceTmux ? "force" : disableTmux ? "disabled" : "auto",
    codexArgs: launchArgs,
    explicitAutonomyMode
  };
}

function shouldAutoBootstrapTmux(mode: "auto" | "force" | "disabled"): boolean {
  if (mode === "disabled") {
    return false;
  }

  if (process.env[AGMO_TMUX_BOOTSTRAPPED_ENV] === "1" || currentTmuxPaneId()) {
    return false;
  }

  if (!isTmuxAvailable()) {
    if (mode === "force") {
      process.stderr.write(
        "[agmo launch] tmux is not installed or unavailable; falling back to normal terminal launch.\n"
      );
    }
    return false;
  }

  if (mode === "force") {
    return true;
  }

  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function ensureTmuxLaunchAttachable(mode: "auto" | "force" | "disabled"): void {
  if (mode !== "force") {
    return;
  }

  if (process.env[AGMO_TMUX_BOOTSTRAPPED_ENV] === "1" || currentTmuxPaneId()) {
    return;
  }

  if (!isTmuxAvailable()) {
    return;
  }

  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new Error(
      "--tmux requires an interactive TTY so Agmo can attach the leader session to tmux; rerun from a terminal or omit --tmux"
    );
  }
}

function buildAutoTmuxSessionName(projectRoot: string): string {
  const slug = basename(projectRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return `agmo-${slug || "session"}`;
}

async function spawnTmuxBootstrap(args: {
  projectRoot: string;
  codexArgs: string[];
}): Promise<void> {
  const cliEntryPath = agmoCliDistEntryPath();
  const sessionName = buildAutoTmuxSessionName(args.projectRoot);
  const innerArgs = ["launch", ...args.codexArgs].map((arg) => shellQuote(arg)).join(" ");
  const shellCommand = [
    `cd ${shellQuote(args.projectRoot)}`,
    `export ${AGMO_TMUX_BOOTSTRAPPED_ENV}=1`,
    `exec ${shellQuote(process.execPath)} ${shellQuote(cliEntryPath)} ${innerArgs}`
  ].join("; ");

  const child = spawn(
    "tmux",
    ["new-session", "-A", "-s", sessionName, `zsh -lc ${shellQuote(shellCommand)}`],
    {
      stdio: "inherit",
      cwd: args.projectRoot,
      env: process.env
    }
  );

  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }

      process.exitCode = code ?? 0;
      resolve();
    });
  });
}

function assertNoConflictingFlags(args: {
  selected: boolean[];
  message: string;
}): void {
  if (args.selected.filter(Boolean).length > 1) {
    throw new Error(args.message);
  }
}

function parseRequiredNumericValue(raw: string | undefined, flagName: string): number {
  if (!raw) {
    throw new Error(`missing value for ${flagName}`);
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flagName} must be a non-negative number`);
  }

  return parsed;
}

function parseLaunchPolicyKey(
  raw: string | undefined,
  usage: string
):
  | "default_cleanup_older_than_hours"
  | "heartbeat_stale_after_ms"
  | "heartbeat_interval_ms"
  | "autonomy_mode" {
  const allowedKeys = new Set([
    "default_cleanup_older_than_hours",
    "heartbeat_stale_after_ms",
    "heartbeat_interval_ms",
    "autonomy_mode"
  ]);

  if (
    !raw ||
    !allowedKeys.has(raw)
  ) {
    throw new Error(usage);
  }

  return raw as
    | "default_cleanup_older_than_hours"
    | "heartbeat_stale_after_ms"
    | "heartbeat_interval_ms"
    | "autonomy_mode";
}

function parseLaunchPolicyValue(
  key: "default_cleanup_older_than_hours" | "heartbeat_stale_after_ms" | "heartbeat_interval_ms" | "autonomy_mode",
  raw: string | undefined
): number | CodexAutonomyMode {
  if (key === "autonomy_mode") {
    const mode = normalizeCodexAutonomyMode(raw);
    if (!mode) {
      throw new Error("autonomy_mode must be one of: full-auto, madmax");
    }
    return mode;
  }

  return parseRequiredNumericValue(raw, "<value>");
}

function compactErrorMessage(error: unknown, maxLength = 200): string {
  const raw = error instanceof Error && error.message.trim().length > 0
    ? error.message
    : String(error);
  const compact = raw.replace(/\s+/g, " ").trim() || "unknown error";
  return compact.length > maxLength ? `${compact.slice(0, Math.max(maxLength - 3, 0))}...` : compact;
}

function compactLine(line: string, maxLength = 240): string {
  const compact = line.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, Math.max(maxLength - 3, 0))}...` : compact;
}

function deterministicCleanupEntryCompare(
  left: CleanupPlanEntry,
  right: CleanupPlanEntry
): number {
  const category = left.category.localeCompare(right.category);
  if (category !== 0) {
    return category;
  }

  const leftTime = left.mtime_ms ?? Number.POSITIVE_INFINITY;
  const rightTime = right.mtime_ms ?? Number.POSITIVE_INFINITY;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return left.relative_path.localeCompare(right.relative_path);
}

function isSafeLaunchSessionId(sessionId: string): boolean {
  return (
    sessionId.length > 0 &&
    sessionId !== "." &&
    sessionId !== ".." &&
    basename(sessionId) === sessionId &&
    !sessionId.includes("/") &&
    !sessionId.includes("\\")
  );
}

function launchSessionIdForAutoCleanup(entry: CleanupPlanEntry): string | null {
  const sessionId = entry.details?.session_id;
  if (
    entry.category !== "cache/launch-workspaces" ||
    entry.reason !== AUTO_CLEANUP_LAUNCH_REASON ||
    typeof sessionId !== "string" ||
    !isSafeLaunchSessionId(sessionId)
  ) {
    return null;
  }

  return sessionId;
}

function launchIdentityForAutoCleanup(entry: CleanupPlanEntry): string | null {
  const sessionId = launchSessionIdForAutoCleanup(entry);
  return sessionId ? `${entry.path}\0${entry.relative_path}\0${sessionId}` : null;
}

function isExactSessionInstructionEntry(entry: CleanupPlanEntry, sessionId: string): boolean {
  return (
    entry.category === "cache/session-instructions" &&
    basename(entry.path) === sessionId &&
    entry.relative_path === `.agmo/cache/session-instructions/${sessionId}`
  );
}

function sessionInstructionEntryForAutoCleanup(
  entry: CleanupPlanEntry,
  selectedSessionIds: Set<string>
): CleanupPlanEntry | null {
  for (const sessionId of selectedSessionIds) {
    if (!isExactSessionInstructionEntry(entry, sessionId)) {
      continue;
    }

    if (entry.reason === AUTO_CLEANUP_SESSION_OLD_REASON) {
      return entry;
    }

    if (entry.reason === AUTO_CLEANUP_SESSION_NEW_REASON) {
      return {
        ...entry,
        reason: AUTO_CLEANUP_PAIRED_REASON,
        details: {
          ...(entry.details ?? {}),
          auto_cleanup_original_reason: entry.reason
        }
      };
    }
  }

  return null;
}

function buildLaunchAutoCleanupPlan(
  firstPlan: CleanupPlanResult,
  secondPlan: CleanupPlanResult
): CleanupPlanResult {
  const selectedSessionIds = new Set(
    firstPlan.would_delete
      .map(launchSessionIdForAutoCleanup)
      .filter((sessionId): sessionId is string => Boolean(sessionId))
  );
  const selectedLaunchIdentities = new Set(
    firstPlan.would_delete
      .map(launchIdentityForAutoCleanup)
      .filter((identity): identity is string => Boolean(identity))
  );

  if (selectedSessionIds.size === 0) {
    return {
      ...secondPlan,
      totals: {
        ...secondPlan.totals,
        would_delete_entries: 0,
        would_delete_bytes: 0,
        kept_entries: secondPlan.would_delete.length + secondPlan.kept.length,
        kept_bytes: [...secondPlan.would_delete, ...secondPlan.kept].reduce(
          (sum, entry) => sum + entry.bytes,
          0
        ),
        projected_bytes_after_delete: secondPlan.totals.inspected_bytes
      },
      would_delete: [],
      kept: [...secondPlan.would_delete, ...secondPlan.kept].sort(deterministicCleanupEntryCompare)
    };
  }

  const executableLaunchEntries: CleanupPlanEntry[] = [];
  const executableSessionIds = new Set<string>();
  for (const entry of secondPlan.would_delete) {
    const sessionId = launchSessionIdForAutoCleanup(entry);
    const identity = launchIdentityForAutoCleanup(entry);
    if (!sessionId || !identity || !selectedLaunchIdentities.has(identity)) {
      continue;
    }

    executableLaunchEntries.push(entry);
    executableSessionIds.add(sessionId);
  }

  const executableSessionEntries = [...secondPlan.would_delete, ...secondPlan.kept]
    .map((entry) => sessionInstructionEntryForAutoCleanup(entry, executableSessionIds))
    .filter((entry): entry is CleanupPlanEntry => Boolean(entry));

  const wouldDelete = [...executableLaunchEntries, ...executableSessionEntries]
    .sort(deterministicCleanupEntryCompare);
  const executablePaths = new Set(wouldDelete.map((entry) => entry.path));
  const kept = [...secondPlan.would_delete, ...secondPlan.kept]
    .filter((entry) => !executablePaths.has(entry.path))
    .sort(deterministicCleanupEntryCompare);

  const wouldDeleteBytes = wouldDelete.reduce((sum, entry) => sum + entry.bytes, 0);
  const keptBytes = kept.reduce((sum, entry) => sum + entry.bytes, 0);

  return {
    ...secondPlan,
    would_delete: wouldDelete,
    kept,
    totals: {
      inspected_entries: secondPlan.totals.inspected_entries,
      inspected_bytes: secondPlan.totals.inspected_bytes,
      would_delete_entries: wouldDelete.length,
      would_delete_bytes: wouldDeleteBytes,
      kept_entries: kept.length,
      kept_bytes: keptBytes,
      projected_bytes_after_delete: Math.max(secondPlan.totals.inspected_bytes - wouldDeleteBytes, 0)
    }
  };
}

export async function runSafeAutoCleanupBeforeLaunch(
  projectRoot: string,
  deps: LaunchAutoCleanupDeps = {}
): Promise<void> {
  const cleanupDeps = { ...defaultLaunchAutoCleanupDeps, ...deps };

  try {
    const policy = await cleanupDeps.resolveCleanupPolicy(projectRoot);
    if (!policy.policy.enabled || !policy.policy.safe_auto_cleanup_on_launch) {
      return;
    }

    const firstPlan = await cleanupDeps.createCleanupPlan(projectRoot);
    const secondPlan = await cleanupDeps.createCleanupPlan(projectRoot);
    const filteredPlan = buildLaunchAutoCleanupPlan(firstPlan, secondPlan);

    if (
      filteredPlan.would_delete.some(
        (entry) =>
          entry.category !== "cache/launch-workspaces" &&
          entry.category !== "cache/session-instructions"
      )
    ) {
      throw new Error("filtered auto-cleanup plan contains a non-launch category");
    }

    if (filteredPlan.would_delete.length === 0) {
      return;
    }

    const result = await cleanupDeps.runCleanupPlan(filteredPlan);
    if (result.run.failures.length > 0) {
      const firstFailure = result.run.failures[0];
      const firstFailureDetails = firstFailure
        ? ` first=${compactErrorMessage(firstFailure.relative_path, 120)}: ${compactErrorMessage(firstFailure.error, 120)}`
        : "";
      const line = `[agmo launch] auto-cleanup incomplete: removed=${result.run.removed.length} skipped=${result.run.skipped.length} failures=${result.run.failures.length}${firstFailureDetails}`;
      cleanupDeps.writeStderr(`${compactLine(line)}\n`);
    }
  } catch (error) {
    cleanupDeps.writeStderr(
      `[agmo launch] auto-cleanup skipped: ${compactErrorMessage(error)}\n`
    );
  }
}

export async function runLaunchCommand(args: string[]): Promise<void> {
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    printLaunchHelp();
    return;
  }

  const projectRoot = resolveRuntimeRoot();
  const launchPolicy = await resolveLaunchPolicy(projectRoot);
  const subcommand = args[0];

  if (subcommand === "config") {
    const action = args[1];

    if (action === "show") {
      const configArgs = args.slice(2);
      const scope = configArgs.includes("--scope") || configArgs.some((arg) => arg.startsWith("--scope="))
        ? parseScopeFlag(configArgs)
        : null;

      if (scope) {
        const scoped = await readScopedAgmoConfig(scope, projectRoot);
        console.log(
          JSON.stringify(
            {
              command: "launch config show",
              mode: "scoped",
              scope,
              config_path: scoped.config_path,
              launch: scoped.config.launch ?? {}
            },
            null,
            2
          )
        );
        return;
      }

      console.log(
        JSON.stringify(
          {
            command: "launch config show",
            mode: "effective",
            ...launchPolicy
          },
          null,
          2
        )
      );
      return;
    }

    if (action === "set") {
      const key = parseLaunchPolicyKey(
        args[2],
        "usage: agmo launch config set <default_cleanup_older_than_hours|heartbeat_stale_after_ms|heartbeat_interval_ms|autonomy_mode> <value> [--scope user|project]"
      );

      const value = parseLaunchPolicyValue(key, args[3]);
      const scope = parseScopeFlag(args.slice(4));
      const result = await setLaunchPolicyValue({
        key,
        value,
        scope,
        cwd: projectRoot
      });
      console.log(
        JSON.stringify(
          {
            command: "launch config set",
            ...result
          },
          null,
          2
        )
      );
      return;
    }

    if (action === "unset") {
      const key = parseLaunchPolicyKey(
        args[2],
        "usage: agmo launch config unset <default_cleanup_older_than_hours|heartbeat_stale_after_ms|heartbeat_interval_ms|autonomy_mode> [--scope user|project]"
      );
      const scope = parseScopeFlag(args.slice(3));
      const result = await unsetLaunchPolicyValue({
        key,
        scope,
        cwd: projectRoot
      });
      console.log(
        JSON.stringify(
          {
            command: "launch config unset",
            ...result
          },
          null,
          2
        )
      );
      return;
    }

    if (action === "reset") {
      const scope = parseScopeFlag(args.slice(2));
      const result = await resetLaunchPolicy({
        scope,
        cwd: projectRoot
      });
      console.log(
        JSON.stringify(
          {
            command: "launch config reset",
            ...result
          },
          null,
          2
        )
      );
      return;
    }

    throw new Error(
      "usage: agmo launch config <show [--scope user|project]|set <key> <value> [--scope user|project]|unset <key> [--scope user|project]|reset [--scope user|project]>"
    );
  }

  if (subcommand === "list") {
    const listArgs = args.slice(1);
    const summaryOnly = listArgs.includes("--summary");
    const verbose = listArgs.includes("--verbose");
    assertNoConflictingFlags({
      selected: [summaryOnly, verbose],
      message: "--summary and --verbose cannot be used together"
    });

    const workspaces = await listLaunchWorkspaces({ projectRoot });
    const summary = summarizeLaunchWorkspaces(workspaces);

    console.log(
      JSON.stringify(
        summaryOnly
          ? {
              command: "launch list",
              project_root: projectRoot,
              output_mode: "summary",
              ...summary
            }
          : {
              command: "launch list",
              project_root: projectRoot,
              output_mode: verbose ? "verbose" : "default",
              ...summary,
              workspaces: verbose
                ? workspaces
                : workspaces.map((workspace) => ({
                    session_id: workspace.session_id,
                    workspace_dir: workspace.workspace_dir,
                    metadata_path: workspace.metadata_path,
                    state: workspace.derived.state,
                    active: workspace.derived.active,
                    stale: workspace.derived.stale,
                    created_age_hours: workspace.derived.created_age_hours,
                    reference_at: workspace.derived.reference_at,
                    reference_age_hours: workspace.derived.reference_age_hours
                  }))
            },
        null,
        2
      )
    );
    return;
  }

  if (subcommand === "cleanup") {
    const cleanupArgs = args.slice(1);
    const all = cleanupArgs.includes("--all");
    const staleOnly = cleanupArgs.includes("--stale");
    const includeActive = cleanupArgs.includes("--include-active");
    const olderThanHoursRaw = parseOption(cleanupArgs, "--older-than-hours");
    const olderThanHours = olderThanHoursRaw
      ? Number.parseInt(olderThanHoursRaw, 10)
      : undefined;
    if (olderThanHoursRaw && !Number.isFinite(olderThanHours)) {
      throw new Error("--older-than-hours must be an integer");
    }
    if (olderThanHours !== undefined && olderThanHours < 0) {
      throw new Error("--older-than-hours must be >= 0");
    }
    if (includeActive && all !== true) {
      throw new Error("--include-active requires --all");
    }

    const result = await cleanupLaunchWorkspaces({
      projectRoot,
      all,
      olderThanHours,
      includeActive,
      staleOnly
    });
    console.log(
      JSON.stringify(
        {
          command: "launch cleanup",
          project_root: projectRoot,
          ...result
        },
        null,
        2
      )
    );
    return;
  }

  const { mode: tmuxMode, codexArgs, explicitAutonomyMode } = resolveLaunchTmuxMode(args);
  const effectiveAutonomyMode = explicitAutonomyMode ?? launchPolicy.policy.autonomy_mode;
  const effectiveCodexArgs = ensureCodexCliArgs(codexArgs, effectiveAutonomyMode);
  ensureTmuxLaunchAttachable(tmuxMode);

  if (shouldAutoBootstrapTmux(tmuxMode)) {
    await spawnTmuxBootstrap({
      projectRoot,
      codexArgs: effectiveCodexArgs
    });
    return;
  }

  await runSafeAutoCleanupBeforeLaunch(projectRoot);

  const workspace = await prepareSessionWorkspace({
    projectRoot
  });

  const child = spawn("codex", effectiveCodexArgs, {
    stdio: "inherit",
    cwd: workspace.workspaceRoot,
    env: {
      ...process.env,
      AGMO_PROJECT_ROOT: projectRoot,
      AGMO_LAUNCH_SESSION_ID: workspace.sessionId,
      AGMO_LAUNCH_WORKSPACE_ROOT: workspace.workspaceRoot,
      [AGMO_CODEX_AUTONOMY_MODE_ENV]: effectiveAutonomyMode
    }
  });

  await recordLaunchWorkspaceStarted({
    metadataPath: workspace.metadataPath,
    launcherPid: process.pid,
    codexPid: child.pid
  });

  let heartbeatWrite = Promise.resolve();
  const heartbeatTimer = setInterval(() => {
    heartbeatWrite = heartbeatWrite
      .catch(() => undefined)
      .then(() =>
        recordLaunchWorkspaceHeartbeat({
          metadataPath: workspace.metadataPath
        })
      )
      .catch(() => undefined);
  }, launchPolicy.policy.heartbeat_interval_ms);
  heartbeatTimer.unref();

  const forwardSignal = (signal: NodeJS.Signals): void => {
    if (child.killed) {
      return;
    }

    try {
      child.kill(signal);
    } catch {
      // ignore forwarding failures
    }
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => forwardSignal(signal));
  }

  try {
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (signal) {
          process.kill(process.pid, signal);
          return;
        }

        process.exitCode = code ?? 1;
        resolve();
      });
    });
  } finally {
    clearInterval(heartbeatTimer);
    await heartbeatWrite;
    await recordLaunchWorkspaceExit({
      metadataPath: workspace.metadataPath,
      exitCode:
        typeof process.exitCode === "number" ? process.exitCode : 1
    });
  }
}
