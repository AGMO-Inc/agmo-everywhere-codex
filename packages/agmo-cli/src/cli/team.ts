import {
  buildLeaderHudView,
  acknowledgeShutdownRequest,
  autoNudgeTeamRuntime,
  acknowledgeDispatchRequest,
  buildLeaderMonitorView,
  configureLeaderAlertDelivery,
  deliverLeaderAlerts,
  deleteTeamRuntime,
  evaluateLeaderEscalations,
  rebalanceTeamAssignments,
  claimTaskForWorker,
  cleanupStaleTeamRuntimes,
  completeTaskForWorker,
  failTaskForWorker,
  heartbeatWorker,
  integrateTeamChanges,
  readTeamLayoutStatus,
  monitorTeamRuntime,
  rebalanceTeamLayout,
  repairTeamHudPane,
  repairTeamLayout,
  resolveMonitorPolicy,
  reclaimTeamClaims,
  readTeamStatus,
  readTeamTmuxHealthSummary,
  readTeamIntegrationAssist,
  reportWorkerStatus,
  retryDispatchRequests,
  sendWorkerMessage,
  showLeaderAlertDeliveryConfig,
  shutdownTeamRuntime,
  startTeamRuntime
} from "../team/runtime.js";
import {
  assertCanonicalTeamName,
  resolveTeamMonitorPolicyPath
} from "../team/state/index.js";
import { parseScopeFlag } from "../utils/args.js";
import { resolveRuntimeRoot } from "../utils/paths.js";
import { writeJsonFile } from "../utils/fs.js";
import { machineJsonEnvelope, uniqueRecommendedActions } from "../utils/machine-json.js";
import {
  buildTeamApiErrorEnvelope,
  executeTeamApiOperation,
  type TeamApiOperation
} from "../team/api.js";
import { ellipsize, fitLines } from "../team/terminal-format.js";

function parseWorkerCount(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error("worker count must be an integer between 1 and 20");
  }
  const parsed = Number.parseInt(value ?? "", 10);
  if (parsed < 1 || parsed > 20) {
    throw new Error("worker count must be an integer between 1 and 20");
  }
  return parsed;
}

function parseIntegerOption(args: string[], optionName: string): number | undefined {
  const raw = parseOption(args, optionName);
  if (!raw) {
    return undefined;
  }
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${optionName} must be an integer`);
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${optionName} must be an integer`);
  }

  return parsed;
}

function assertMinimumOption(
  value: number | undefined,
  optionName: string,
  minimum: number
): void {
  if (value !== undefined && value < minimum) {
    throw new Error(`${optionName} must be at least ${minimum}`);
  }
}

function parseBooleanFlag(
  args: string[],
  enableFlag: string,
  disableFlag: string
): boolean | undefined {
  const enabled = args.includes(enableFlag);
  const disabled = args.includes(disableFlag);

  if (enabled && disabled) {
    throw new Error(`cannot use both ${enableFlag} and ${disableFlag}`);
  }
  if (enabled) {
    return true;
  }
  if (disabled) {
    return false;
  }
  return undefined;
}

function parseHudPreset(value: string | undefined): "minimal" | "sidecar" | "focused" | "full" | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "minimal" || value === "sidecar" || value === "focused" || value === "full") {
    return value;
  }
  throw new Error("--preset must be one of: minimal, sidecar, focused, full");
}

function parseColorMode(args: string[]): "auto" | "always" | "never" | undefined {
  const color = args.includes("--color");
  const noColor = args.includes("--no-color");
  if (color && noColor) {
    throw new Error("cannot use both --color and --no-color");
  }
  if (color) {
    return "always";
  }
  if (noColor) {
    return "never";
  }
  return undefined;
}

const TEAM_API_OPERATION_NAMES = [
  "send-message",
  "broadcast",
  "mailbox-list",
  "mailbox-mark-delivered",
  "mailbox-mark-notified",
  "create-task",
  "update-task",
  "release-task-claim",
  "read-config",
  "read-manifest",
  "read-worker-status",
  "read-worker-heartbeat",
  "update-worker-heartbeat",
  "write-worker-inbox",
  "write-worker-identity",
  "append-event",
  "read-events",
  "await-event",
  "read-monitor-snapshot",
  "write-monitor-snapshot",
  "write-shutdown-request",
  "read-shutdown-ack",
  "read-idle-state",
  "read-stall-state",
  "read-task-approval",
  "write-task-approval",
  "read-task",
  "list-tasks",
  "get-summary",
  "cleanup",
  "orphan-cleanup",
  "claim-task",
  "transition-task-status"
] as const satisfies readonly TeamApiOperation[];

const TEAM_API_OPERATION_USAGE = TEAM_API_OPERATION_NAMES.join("|");

function parseTeamApiOperation(value: string | undefined): TeamApiOperation {
  if (TEAM_API_OPERATION_NAMES.includes(value as TeamApiOperation)) {
    return value as TeamApiOperation;
  }
  throw new Error(
    `usage: agmo team api <${TEAM_API_OPERATION_USAGE}> --input '<json>' --json`
  );
}

function parseTeamApiInput(args: string[]): { input?: string; error?: string } {
  let input: string | undefined;
  try {
    input = parseOption(args, "--input");
  } catch (error) {
    return { error: errorMessage(error) };
  }
  const remaining = removeOption(args, "--input").filter((arg) => arg !== "--json");
  if (remaining.length > 0) {
    return { error: `unknown team api option: ${remaining[0]}` };
  }
  return { input };
}

function parseRoleMapOption(value: string | undefined): Record<string, string> | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const output: Record<string, string> = {};
  for (const entry of entries) {
    const [workerName, role] = entry.split("=").map((part) => part?.trim());
    if (!workerName || !role) {
      throw new Error("--role-map must look like worker-1=agmo-planner,worker-2=agmo-executor");
    }
    if (Object.hasOwn(output, workerName)) {
      throw new Error(`--role-map repeats ${workerName}`);
    }
    output[workerName] = role;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type TeamHudWatchLoopStreams = {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
};

type TeamHudSignalProcess = {
  on(signal: "SIGINT", handler: () => void): unknown;
  off(signal: "SIGINT", handler: () => void): unknown;
};

type TeamHudWatchLoopOptions = {
  watch: boolean;
  clearScreen: boolean;
  iterations?: number;
  intervalMs: number;
  renderFrame: () => Promise<string>;
  sleepFn?: (ms: number) => Promise<void>;
  streams?: TeamHudWatchLoopStreams;
  signalProcess?: TeamHudSignalProcess;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

type TeamStatusSnapshot = NonNullable<Awaited<ReturnType<typeof readTeamStatus>>>;
type TeamTmuxHealthSummary = NonNullable<
  Awaited<ReturnType<typeof readTeamTmuxHealthSummary>>
>;

function buildTeamStatusRecommendedActions(
  teamName: string,
  status: TeamStatusSnapshot | null,
  tmuxHealth: TeamTmuxHealthSummary | null
): string[] {
  if (!status) {
    return [`team start <workers> "<task>" --name ${teamName}`];
  }

  return uniqueRecommendedActions([
    !status.config.active || !status.phase.active
      ? `team delete ${teamName} --dry-run`
      : undefined,
    tmuxHealth?.layout === "repairable" ? `team layout repair ${teamName}` : undefined,
    tmuxHealth?.layout === "degraded" ? `team layout rebalance ${teamName} --dry-run` : undefined,
    (tmuxHealth?.retry_pending ?? 0) > 0 ||
    (tmuxHealth?.retry_manual_required ?? 0) > 0 ||
    (tmuxHealth?.orphan_warnings.length ?? 0) > 0
      ? "team cleanup-stale --retry-pane-closes --sweep-tmux"
      : undefined
  ]);
}

function teamCommandOperation(command: string): string {
  return command.replace(/^team\s+/, "team.").replace(/\s+/g, ".");
}

function printTeamMachineJson(
  command: string,
  payload: Record<string, unknown>,
  options: { ok?: boolean } = {}
): void {
  console.log(
    JSON.stringify(
      machineJsonEnvelope(teamCommandOperation(command), options.ok ?? true, {
        command,
        ...payload
      }),
      null,
      2
    )
  );
}

function printTeamMachineJsonPayload(
  payload: Record<string, unknown> & { command: string },
  options: { ok?: boolean } = {}
): void {
  console.log(
    JSON.stringify(
      machineJsonEnvelope(teamCommandOperation(payload.command), options.ok ?? true, payload),
      null,
      2
    )
  );
}

function boundedWatchErrorLine(error: unknown, width = 200): string {
  const sanitized = errorMessage(error).replace(/\s+/g, " ").trim();
  return ellipsize(`watch render error: ${sanitized}`, width);
}

export async function runTeamHudWatchLoop({
  watch,
  clearScreen,
  iterations,
  intervalMs,
  renderFrame,
  sleepFn = sleep,
  streams = { stdout: process.stdout, stderr: process.stderr },
  signalProcess = process
}: TeamHudWatchLoopOptions): Promise<void> {
  let previousText: string | null = null;
  let previousHeight = 0;
  let stdoutEndsCleanly = true;
  let interrupted = false;

  const writeStdout = (text: string): void => {
    streams.stdout.write(text);
    stdoutEndsCleanly = text.endsWith("\n");
  };
  const ensureFinalStdoutNewline = (): void => {
    if (!stdoutEndsCleanly) {
      streams.stdout.write("\n");
      stdoutEndsCleanly = true;
    }
  };
  const handleSigint = (): void => {
    interrupted = true;
  };

  if (watch) {
    signalProcess.on("SIGINT", handleSigint);
  }

  try {
    const maxIterations = watch ? iterations ?? Number.POSITIVE_INFINITY : 1;
    for (let index = 0; index < maxIterations && !interrupted; index += 1) {
      let outputText: string;
      try {
        outputText = await renderFrame();
      } catch (error) {
        ensureFinalStdoutNewline();
        if (watch) {
          streams.stderr.write(`${boundedWatchErrorLine(error)}\n`);
        }
        throw error;
      }

      if (watch && clearScreen && outputText === previousText) {
        if (index + 1 < maxIterations && !interrupted) {
          await sleepFn(intervalMs);
        }
        continue;
      }

      if (watch && clearScreen) {
        const nextHeight = outputText.split("\n").length;
        writeStdout("\x1b[H\x1b[2J");
        if (previousHeight > nextHeight) {
          writeStdout("\x1b[J");
        }
        previousHeight = nextHeight;
      }
      previousText = outputText;
      writeStdout(`${outputText}\n`);

      if (index + 1 < maxIterations && !interrupted) {
        await sleepFn(intervalMs);
      }
    }
  } finally {
    if (watch) {
      signalProcess.off("SIGINT", handleSigint);
    }
    ensureFinalStdoutNewline();
  }
}

function parseOption(args: string[], optionName: string): string | undefined {
  const exactIndex = args.findIndex((arg) => arg === optionName);
  if (exactIndex >= 0) {
    const value = args[exactIndex + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${optionName} requires a value`);
    }
    return value;
  }

  const inline = args.find((arg) => arg.startsWith(`${optionName}=`));
  if (!inline) {
    return undefined;
  }
  const value = inline.slice(optionName.length + 1);
  if (!value) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function removeOption(args: string[], optionName: string): string[] {
  const output: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === optionName) {
      index += 1;
      continue;
    }

    if (current.startsWith(`${optionName}=`)) {
      continue;
    }

    output.push(current);
  }

  return output;
}

function readTeamStartSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const sessionId =
    env.AGMO_SESSION_ID?.trim() ||
    env.AGMO_NATIVE_SESSION_ID?.trim() ||
    env.CODEX_SESSION_ID?.trim() ||
    "";

  return sessionId || undefined;
}

export async function runTeamCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  const cwd = resolveRuntimeRoot();

  switch (subcommand) {
    case "api": {
      const operation = parseTeamApiOperation(args[1]);
      const parsedInput = parseTeamApiInput(args.slice(2));
      const envelope = parsedInput.error
        ? buildTeamApiErrorEnvelope(operation, "invalid_input", parsedInput.error)
        : await executeTeamApiOperation(operation, parsedInput.input, cwd);
      console.log(JSON.stringify(envelope, null, 2));
      if (!envelope.ok) {
        process.exitCode = 1;
      }
      return;
    }
    case "start": {
      parseScopeFlag(args.slice(1));
      const workers = parseWorkerCount(args[1]);
      const hudRefreshMs = parseIntegerOption(args.slice(2), "--hud-refresh-ms");
      assertMinimumOption(hudRefreshMs, "--hud-refresh-ms", 250);
      const hudClearScreen = parseBooleanFlag(args.slice(2), "--hud-clear", "--hud-no-clear");
      const allocationIntent = parseOption(args.slice(2), "--allocation-intent");
      const roleOverrides = parseRoleMapOption(parseOption(args.slice(2), "--role-map"));
      const taskArgs = removeOption(
        removeOption(
          removeOption(
            removeOption(
              removeOption(removeOption(args.slice(2), "--name"), "--hud"),
              "--allocation-intent"
            ),
            "--hud-refresh-ms"
          ),
          "--hud-clear"
        ),
        "--hud-no-clear"
      );
      const finalTaskArgs = removeOption(taskArgs, "--role-map");
      const task = finalTaskArgs.join(" ").trim();
      if (!task) {
        throw new Error("task is required");
      }
      if (
        allocationIntent &&
        !["implementation", "verification", "planning", "knowledge"].includes(allocationIntent)
      ) {
        throw new Error(
          "--allocation-intent must be: implementation, verification, planning, knowledge"
        );
      }
      const teamName = parseOption(args.slice(2), "--name");
      if (teamName !== undefined) {
        assertCanonicalTeamName(teamName, "--name");
      }
      const result = await startTeamRuntime({
        teamName,
        workerCount: workers,
        task,
        mode: "interactive",
        sessionId: readTeamStartSessionId(),
        spawnTmuxPanes: true,
        tmuxSpawnIntent: "live-team-runtime",
        hud: args.slice(2).includes("--hud"),
        hudRefreshMs,
        hudClearScreen,
        allocationIntent:
          allocationIntent === "implementation" ||
          allocationIntent === "verification" ||
          allocationIntent === "planning" ||
          allocationIntent === "knowledge"
            ? allocationIntent
            : undefined,
        roleOverrides
      }, cwd);
      printTeamMachineJson("team start", result);
      return;
    }
    case "status": {
      const teamName = args[1];
      if (!teamName) {
        throw new Error("team name is required");
      }
      const status = await readTeamStatus(teamName, cwd);
      const tmuxHealth = status ? await readTeamTmuxHealthSummary(teamName, cwd) : null;
      const recommendedActions = buildTeamStatusRecommendedActions(teamName, status, tmuxHealth);
      printTeamMachineJson(
        "team status",
        {
          team_name: teamName,
          found: Boolean(status),
          recommended_actions: recommendedActions,
          tmux_health: tmuxHealth,
          status
        },
        { ok: Boolean(status) && recommendedActions.length === 0 }
      );
      return;
    }
    case "shutdown-ack": {
      const [teamName, workerName, ackStatus] = args.slice(1, 4);
      if (!teamName || !workerName || !ackStatus) {
        throw new Error(
          "usage: agmo team shutdown-ack <team> <worker> <accepted|busy|rejected> [--reason <text>] [--task <id>]"
        );
      }
      if (!["accepted", "busy", "rejected"].includes(ackStatus)) {
        throw new Error("shutdown ack status must be one of: accepted, busy, rejected");
      }
      const result = await acknowledgeShutdownRequest(
        teamName,
        workerName,
        ackStatus as "accepted" | "busy" | "rejected",
        {
          reason: parseOption(args.slice(4), "--reason"),
          taskId: parseOption(args.slice(4), "--task")
        },
        cwd
      );
      printTeamMachineJson("team shutdown-ack", result);
      return;
    }
    case "shutdown": {
      const teamName = args[1];
      if (!teamName) {
        throw new Error("team name is required");
      }
      const graceMs = parseIntegerOption(args.slice(2), "--grace-ms") ?? 2000;
      if (graceMs < 0) {
        throw new Error("--grace-ms must be at least 0");
      }
      const result = await shutdownTeamRuntime(teamName, { graceMs }, cwd);
      printTeamMachineJson("team shutdown", result);
      return;
    }
    case "delete": {
      const teamName = args[1];
      if (!teamName) {
        throw new Error(
          "usage: agmo team delete <team> [--force] [--dry-run] [--keep-worktrees|--remove-worktrees]"
        );
      }
      const keepWorktrees = args.slice(2).includes("--keep-worktrees");
      const removeWorktrees = args.slice(2).includes("--remove-worktrees");
      if (keepWorktrees && removeWorktrees) {
        throw new Error("cannot use both --keep-worktrees and --remove-worktrees");
      }
      const result = await deleteTeamRuntime(
        teamName,
        {
          force: args.slice(2).includes("--force"),
          dryRun: args.slice(2).includes("--dry-run"),
          keepWorktrees
        },
        cwd
      );
      printTeamMachineJson("team delete", result);
      return;
    }
    case "cleanup-stale": {
      const staleAfterMs = parseIntegerOption(args.slice(1), "--stale-ms");
      const deadAfterMs = parseIntegerOption(args.slice(1), "--dead-ms");
      assertMinimumOption(staleAfterMs, "--stale-ms", 0);
      assertMinimumOption(deadAfterMs, "--dead-ms", 0);
      const includeStale = parseBooleanFlag(
        args.slice(1),
        "--include-stale",
        "--no-include-stale"
      );
      const dryRun = parseBooleanFlag(args.slice(1), "--dry-run", "--no-dry-run");
      const retryPaneCloses = parseBooleanFlag(
        args.slice(1),
        "--retry-pane-closes",
        "--no-retry-pane-closes"
      );
      const sweepTmux = parseBooleanFlag(args.slice(1), "--sweep-tmux", "--no-sweep-tmux");
      const result = await cleanupStaleTeamRuntimes(
        {
          staleAfterMs,
          deadAfterMs,
          includeStale,
          dryRun,
          retryPaneCloses,
          sweepTmux
        },
        cwd
      );
      printTeamMachineJson("team cleanup-stale", {
        recommended_actions: [],
        ...result
      });
      return;
    }
    case "send": {
      const [teamName, workerName, ...messageParts] = args.slice(1);
      const message = messageParts.join(" ").trim();
      if (!teamName || !workerName || !message) {
        throw new Error("usage: agmo team send <team> <worker> \"<message>\"");
      }
      const result = await sendWorkerMessage(teamName, workerName, message, cwd);
      printTeamMachineJson("team send", result);
      return;
    }
    case "claim": {
      const [teamName, taskId, workerName] = args.slice(1);
      if (!teamName || !taskId || !workerName) {
        throw new Error("usage: agmo team claim <team> <task-id> <worker> [--ignore-dependencies]");
      }
      const result = await claimTaskForWorker(
        teamName,
        taskId,
        workerName,
        {
          ignoreDependencies: args.slice(4).includes("--ignore-dependencies")
        },
        cwd
      );
      printTeamMachineJson("team claim", result);
      return;
    }
    case "complete": {
      const [teamName, taskId, workerName, ...resultParts] = args.slice(1);
      if (!teamName || !taskId || !workerName) {
        throw new Error(
          "usage: agmo team complete <team> <task-id> <worker> [result text]"
        );
      }
      const autoIntegrate = args.slice(1).includes("--auto-integrate");
      const integrateStrategy = parseOption(args.slice(1), "--integrate-strategy");
      const integrateMaxCommits = parseIntegerOption(args.slice(1), "--integrate-max-commits");
      assertMinimumOption(integrateMaxCommits, "--integrate-max-commits", 1);
      const integrateOnConflict = parseOption(args.slice(1), "--integrate-on-conflict");
      const integrateOnEmpty = parseOption(args.slice(1), "--integrate-on-empty");
      const integrateTargetRef = parseOption(args.slice(1), "--integrate-target-ref");
      const integrateCheckoutTarget = args.slice(1).includes("--integrate-checkout-target");
      if (integrateStrategy && !["cherry-pick", "squash"].includes(integrateStrategy)) {
        throw new Error("--integrate-strategy must be: cherry-pick, squash");
      }
      if (integrateOnConflict && !["continue", "stop"].includes(integrateOnConflict)) {
        throw new Error("--integrate-on-conflict must be: continue, stop");
      }
      if (integrateOnEmpty && !["skip", "fail"].includes(integrateOnEmpty)) {
        throw new Error("--integrate-on-empty must be: skip, fail");
      }
      const resultArgs = removeOption(
        removeOption(
          removeOption(
            removeOption(
              removeOption(resultParts, "--integrate-strategy"),
              "--integrate-max-commits"
            ),
            "--integrate-on-conflict"
          ),
          "--integrate-on-empty"
        ),
        "--integrate-target-ref"
      );
      const finalResultArgs = removeOption(
        removeOption(resultArgs, "--integrate-checkout-target"),
        "--auto-integrate"
      );
      const result = await completeTaskForWorker(
        teamName,
        taskId,
        workerName,
        finalResultArgs.join(" ").trim() || undefined,
        cwd
      );
      const integration = autoIntegrate
        ? await integrateTeamChanges(
            teamName,
            {
              taskId,
              workerName,
              strategy:
                integrateStrategy === "cherry-pick" || integrateStrategy === "squash"
                  ? integrateStrategy
                  : undefined,
              maxCommits: integrateMaxCommits,
              onConflict:
                integrateOnConflict === "continue" || integrateOnConflict === "stop"
                  ? integrateOnConflict
                  : undefined,
              onEmpty:
                integrateOnEmpty === "skip" || integrateOnEmpty === "fail"
                  ? integrateOnEmpty
                  : undefined,
              targetRef: integrateTargetRef,
              checkoutTarget: integrateCheckoutTarget
            },
            cwd
          )
        : null;
      printTeamMachineJson("team complete", {
        ...result,
        ...(integration ? { integration } : {})
      });
      return;
    }
    case "fail": {
      const [teamName, taskId, workerName, ...errorParts] = args.slice(1);
      if (!teamName || !taskId || !workerName) {
        throw new Error("usage: agmo team fail <team> <task-id> <worker> [error text]");
      }
      const result = await failTaskForWorker(
        teamName,
        taskId,
        workerName,
        errorParts.join(" ").trim() || undefined,
        cwd
      );
      printTeamMachineJson("team fail", result);
      return;
    }
    case "heartbeat": {
      const [teamName, workerName] = args.slice(1);
      if (!teamName || !workerName) {
        throw new Error("usage: agmo team heartbeat <team> <worker>");
      }
      const result = await heartbeatWorker(teamName, workerName, cwd);
      printTeamMachineJson("team heartbeat", result);
      return;
    }
    case "report": {
      const [teamName, workerName, state] = args.slice(1, 4);
      if (!teamName || !workerName || !state) {
        throw new Error(
          "usage: agmo team report <team> <worker> <idle|working|done|blocked> [--task <id>] [--note <text>]"
        );
      }
      if (!["idle", "working", "done", "blocked"].includes(state)) {
        throw new Error("state must be one of: idle, working, done, blocked");
      }
      const taskId = parseOption(args.slice(4), "--task");
      const note = parseOption(args.slice(4), "--note");
      const result = await reportWorkerStatus(
        teamName,
        workerName,
        state as "idle" | "working" | "done" | "blocked",
        { taskId, note },
        cwd
      );
      printTeamMachineJson("team report", result);
      return;
    }
    case "monitor": {
      const teamName = args[1];
      if (!teamName) {
        throw new Error(
          "usage: agmo team monitor <team> [--preset observe|conservative|balanced|aggressive] [--stale-ms <ms>] [--dead-ms <ms>] [--auto-nudge|--no-auto-nudge] [--nudge-cooldown-ms <ms>] [--auto-reclaim|--no-auto-reclaim] [--auto-reassign|--no-auto-reassign] [--reclaim-lease-ms <ms>] [--include-stale|--no-include-stale] [--escalate-leader|--no-escalate-leader] [--notify-on-stale|--no-notify-on-stale] [--notify-on-dead|--no-notify-on-dead] [--notify-on-claim-risk|--no-notify-on-claim-risk] [--leader-alert-cooldown-ms <ms>] [--escalation-repeat-threshold <n>] [--repair-hud] [--leader-view]"
        );
      }
      const preset = parseOption(args.slice(2), "--preset");
      const staleAfterMs = parseIntegerOption(args.slice(2), "--stale-ms");
      const deadAfterMs = parseIntegerOption(args.slice(2), "--dead-ms");
      const autoNudgeOverride = parseBooleanFlag(
        args.slice(2),
        "--auto-nudge",
        "--no-auto-nudge"
      );
      const autoReclaimOverride = parseBooleanFlag(
        args.slice(2),
        "--auto-reclaim",
        "--no-auto-reclaim"
      );
      const autoReassignOverride = parseBooleanFlag(
        args.slice(2),
        "--auto-reassign",
        "--no-auto-reassign"
      );
      const includeStaleOverride = parseBooleanFlag(
        args.slice(2),
        "--include-stale",
        "--no-include-stale"
      );
      const escalateLeaderOverride = parseBooleanFlag(
        args.slice(2),
        "--escalate-leader",
        "--no-escalate-leader"
      );
      const notifyOnStaleOverride = parseBooleanFlag(
        args.slice(2),
        "--notify-on-stale",
        "--no-notify-on-stale"
      );
      const notifyOnDeadOverride = parseBooleanFlag(
        args.slice(2),
        "--notify-on-dead",
        "--no-notify-on-dead"
      );
      const notifyOnClaimRiskOverride = parseBooleanFlag(
        args.slice(2),
        "--notify-on-claim-risk",
        "--no-notify-on-claim-risk"
      );
      const leaderView = args.slice(2).includes("--leader-view");
      const repairHud = args.slice(2).includes("--repair-hud");
      const cooldownMs = parseIntegerOption(args.slice(2), "--nudge-cooldown-ms");
      const reclaimLeaseMs = parseIntegerOption(args.slice(2), "--reclaim-lease-ms");
      const leaderAlertCooldownMs = parseIntegerOption(args.slice(2), "--leader-alert-cooldown-ms");
      const escalationRepeatThreshold = parseIntegerOption(
        args.slice(2),
        "--escalation-repeat-threshold"
      );
      assertMinimumOption(staleAfterMs, "--stale-ms", 0);
      assertMinimumOption(deadAfterMs, "--dead-ms", 0);
      assertMinimumOption(cooldownMs, "--nudge-cooldown-ms", 0);
      assertMinimumOption(reclaimLeaseMs, "--reclaim-lease-ms", 0);
      assertMinimumOption(leaderAlertCooldownMs, "--leader-alert-cooldown-ms", 0);
      assertMinimumOption(escalationRepeatThreshold, "--escalation-repeat-threshold", 1);
      if (
        preset &&
        !["observe", "conservative", "balanced", "aggressive"].includes(preset)
      ) {
        throw new Error("--preset must be: observe, conservative, balanced, aggressive");
      }
      const policy = resolveMonitorPolicy({
        preset:
          preset === "observe" ||
          preset === "conservative" ||
          preset === "balanced" ||
          preset === "aggressive"
            ? preset
            : undefined,
        staleAfterMs,
        deadAfterMs,
        autoNudge: autoNudgeOverride,
        autoReclaim: autoReclaimOverride,
        autoReassign: autoReassignOverride,
        includeStale: includeStaleOverride,
        cooldownMs,
        reclaimLeaseMs,
        escalateLeader: escalateLeaderOverride,
        notifyOnStale: notifyOnStaleOverride,
        notifyOnDead: notifyOnDeadOverride,
        notifyOnClaimRisk: notifyOnClaimRiskOverride,
        leaderAlertCooldownMs,
        escalationRepeatThreshold
      });
      const snapshot = await monitorTeamRuntime(
        teamName,
        {
          staleAfterMs: policy.stale_after_ms,
          deadAfterMs: policy.dead_after_ms
        },
        cwd
      );
      const autoNudges = policy.auto_nudge
        ? await autoNudgeTeamRuntime(
            teamName,
            snapshot,
            { cooldownMs: policy.nudge_cooldown_ms },
            cwd
          )
        : null;
      const autoRecovery = policy.auto_reclaim
        ? await reclaimTeamClaims(
            teamName,
            {
              staleAfterMs: policy.stale_after_ms,
              deadAfterMs: policy.dead_after_ms,
              leaseMs: policy.reclaim_lease_ms,
              reassign: policy.auto_reassign,
              includeStale: policy.include_stale
            },
            cwd
          )
        : null;
      const hudRepair = repairHud ? await repairTeamHudPane(teamName, cwd) : null;
      const finalSnapshot = autoRecovery || hudRepair?.status === "repaired"
        ? await monitorTeamRuntime(
            teamName,
            {
              staleAfterMs: policy.stale_after_ms,
              deadAfterMs: policy.dead_after_ms
            },
            cwd
          )
        : snapshot;
      const effectivePolicy = {
        ...policy,
        updated_at: finalSnapshot.checked_at
      };
      const leaderAlerts = effectivePolicy.escalate_leader
        ? await evaluateLeaderEscalations(teamName, finalSnapshot, effectivePolicy, cwd)
        : null;
      const leaderAlertDelivery =
        leaderAlerts && leaderAlerts.alerts.some((entry) => entry.status === "emitted")
          ? await deliverLeaderAlerts(
              teamName,
              leaderAlerts.alerts.filter((entry) => entry.status === "emitted"),
              cwd
            )
          : null;
      await writeJsonFile(resolveTeamMonitorPolicyPath(teamName, cwd), effectivePolicy);
      if (leaderView) {
        const leaderMonitor = await buildLeaderMonitorView(
          teamName,
          finalSnapshot,
          {
            policy: effectivePolicy,
            leaderAlerts: leaderAlerts?.alerts.map((entry) => ({
              worker_name: entry.worker_name,
              kind: entry.kind,
              severity: entry.severity,
              status: entry.status
            })),
            autoNudges: autoNudges?.nudges.map((entry) => ({
              worker_name: entry.worker_name,
              status: entry.status
            })),
            autoRecovery: autoRecovery?.reclaimed.map((entry) => ({
              task_id: entry.task_id,
              reassigned: entry.reassigned,
              previous_owner: entry.previous_owner,
              next_owner: entry.next_owner
            })),
            leaderAlertDelivery: leaderAlertDelivery?.attempts
          },
          cwd
        );
        process.stdout.write(`${leaderMonitor.markdown}\n`);
      } else {
        printTeamMachineJson("team monitor", {
          policy: effectivePolicy,
          snapshot: finalSnapshot,
          ...(leaderAlerts ? { leader_alerts: leaderAlerts.alerts } : {}),
          ...(leaderAlertDelivery
            ? { leader_alert_delivery: leaderAlertDelivery }
            : {}),
          ...(autoNudges ? { auto_nudges: autoNudges.nudges } : {}),
          ...(autoRecovery ? { auto_recovery: autoRecovery.reclaimed } : {}),
          ...(hudRepair ? { hud_repair: hudRepair } : {})
        });
      }
      return;
    }
    case "alert-delivery": {
      const action = args[1];
      const teamName = args[2];
      if (!action || !teamName) {
        throw new Error(
          "usage: agmo team alert-delivery <show|set> <team> [--mailbox|--no-mailbox] [--slack|--no-slack] [--slack-webhook-url <url>] [--slack-username <name>] [--slack-icon-emoji <emoji>] [--email|--no-email] [--email-to <a,b>] [--email-from <addr>] [--email-sendmail-path <path>] [--email-subject-prefix <prefix>]"
        );
      }

      if (action === "show") {
        const result = await showLeaderAlertDeliveryConfig(teamName, cwd);
        printTeamMachineJson("team alert-delivery show", result);
        return;
      }

      if (action === "set") {
        const mailboxEnabled = parseBooleanFlag(
          args.slice(3),
          "--mailbox",
          "--no-mailbox"
        );
        const slackEnabled = parseBooleanFlag(args.slice(3), "--slack", "--no-slack");
        const emailEnabled = parseBooleanFlag(args.slice(3), "--email", "--no-email");
        const emailTo = parseOption(args.slice(3), "--email-to");
        const result = await configureLeaderAlertDelivery(
          teamName,
          {
            mailboxEnabled,
            slackEnabled,
            slackWebhookUrl: parseOption(args.slice(3), "--slack-webhook-url"),
            slackUsername: parseOption(args.slice(3), "--slack-username"),
            slackIconEmoji: parseOption(args.slice(3), "--slack-icon-emoji"),
            emailEnabled,
            emailTo: emailTo
              ? emailTo
                  .split(",")
                  .map((entry) => entry.trim())
                  .filter(Boolean)
              : undefined,
            emailFrom: parseOption(args.slice(3), "--email-from"),
            emailSendmailPath: parseOption(args.slice(3), "--email-sendmail-path"),
            emailSubjectPrefix: parseOption(args.slice(3), "--email-subject-prefix")
          },
          cwd
        );
        printTeamMachineJson("team alert-delivery set", result);
        return;
      }

      throw new Error(
        "usage: agmo team alert-delivery <show|set> <team> [--mailbox|--no-mailbox] [--slack|--no-slack] [--slack-webhook-url <url>] [--slack-username <name>] [--slack-icon-emoji <emoji>] [--email|--no-email] [--email-to <a,b>] [--email-from <addr>] [--email-sendmail-path <path>] [--email-subject-prefix <prefix>]"
      );
    }
    case "hud": {
      const teamName = args[1];
      if (!teamName) {
        throw new Error(
          "usage: agmo team hud <team> [--json] [--stale-ms <ms>] [--dead-ms <ms>] [--watch] [--refresh-ms <ms>] [--iterations <n>] [--repair] [--clear|--no-clear] [--preset minimal|sidecar|focused|full] [--width <cols>] [--max-lines <n>] [--legend] [--color|--no-color]"
        );
      }
      const staleAfterMs = parseIntegerOption(args.slice(2), "--stale-ms");
      const deadAfterMs = parseIntegerOption(args.slice(2), "--dead-ms");
      const refreshMs = parseIntegerOption(args.slice(2), "--refresh-ms");
      const iterations = parseIntegerOption(args.slice(2), "--iterations");
      const width = parseIntegerOption(args.slice(2), "--width");
      const maxLines = parseIntegerOption(args.slice(2), "--max-lines");
      const preset = parseHudPreset(parseOption(args.slice(2), "--preset"));
      const color = parseColorMode(args.slice(2));
      const clearScreen = parseBooleanFlag(args.slice(2), "--clear", "--no-clear") ?? true;
      const watch = args.slice(2).includes("--watch");
      const repair = args.slice(2).includes("--repair");
      const showLegend = args.slice(2).includes("--legend");
      const json = args.slice(2).includes("--json");
      if (json && watch) {
        throw new Error("--json cannot be used with --watch");
      }
      assertMinimumOption(staleAfterMs, "--stale-ms", 0);
      assertMinimumOption(deadAfterMs, "--dead-ms", 0);
      assertMinimumOption(refreshMs, "--refresh-ms", 250);
      assertMinimumOption(iterations, "--iterations", 1);
      assertMinimumOption(width, "--width", 20);
      assertMinimumOption(maxLines, "--max-lines", 1);
      const intervalMs = refreshMs ?? 2000;
      if (json) {
        if (repair) {
          await repairTeamHudPane(teamName, cwd);
        }
        const hud = await buildLeaderHudView(
          teamName,
          { staleAfterMs, deadAfterMs, preset, width, maxLines, color, showLegend },
          cwd
        );
        printTeamMachineJson("team hud", {
          team_name: hud.team_name,
          path: hud.path,
          text: hud.text,
          preset: preset ?? "focused",
          width: width ?? null,
          max_lines: maxLines ?? null,
          legend: showLegend
        });
        return;
      }
      const renderHudFrame = async (): Promise<string> => {
        if (repair) {
          await repairTeamHudPane(teamName, cwd);
        }
        const renderWidth =
          width ??
          (watch && process.stdout.isTTY && Number.isFinite(process.stdout.columns)
            ? process.stdout.columns
            : undefined);
        const hud = await buildLeaderHudView(
          teamName,
          { staleAfterMs, deadAfterMs, preset, width: renderWidth, maxLines, color, showLegend },
          cwd
        );
        const footer =
          watch
            ? `watch refresh=${intervalMs}ms checked=${new Date().toISOString()}`
            : null;
        const outputText =
          footer && renderWidth
            ? `${hud.text}\n${ellipsize(footer, renderWidth)}`
            : footer
              ? `${hud.text}\n${footer}`
              : hud.text;
        if (maxLines !== undefined) {
          const maxWidth = renderWidth ?? width ?? 100;
          return fitLines(outputText.split("\n"), maxWidth, maxLines).join("\n");
        }
        return outputText;
      };
      await runTeamHudWatchLoop({
        watch,
        clearScreen,
        iterations,
        intervalMs,
        renderFrame: renderHudFrame
      });
      return;
    }
    case "layout": {
      const layoutCommand = args[1];
      if (layoutCommand === "status") {
        const teamName = args[2];
        if (!teamName) {
          throw new Error("usage: agmo team layout status <team>");
        }
        const result = await readTeamLayoutStatus(teamName, cwd);
        printTeamMachineJsonPayload(result);
        return;
      }
      if (layoutCommand === "repair") {
        const teamName = args[2];
        if (!teamName) {
          throw new Error("usage: agmo team layout repair <team> [--dry-run] [--force]");
        }
        const result = await repairTeamLayout(
          teamName,
          {
            dryRun: args.slice(3).includes("--dry-run"),
            force: args.slice(3).includes("--force")
          },
          cwd
        );
        printTeamMachineJsonPayload(result);
        return;
      }
      if (layoutCommand === "rebalance") {
        const teamName = args[2];
        if (!teamName) {
          throw new Error("usage: agmo team layout rebalance <team> [--layout auto|main-vertical|tiled] [--dry-run]");
        }
        const layout = parseOption(args.slice(3), "--layout") ?? "auto";
        if (layout !== "auto" && layout !== "main-vertical" && layout !== "tiled") {
          throw new Error("--layout must be one of: auto, main-vertical, tiled");
        }
        const result = await rebalanceTeamLayout(
          teamName,
          {
            dryRun: args.slice(3).includes("--dry-run"),
            layout
          },
          cwd
        );
        printTeamMachineJsonPayload(result);
        return;
      }
      throw new Error(
        "usage: agmo team layout status <team> | agmo team layout repair <team> [--dry-run] [--force] | agmo team layout rebalance <team> [--layout auto|main-vertical|tiled] [--dry-run]"
      );
    }
    case "dispatch-ack": {
      const [teamName, requestId] = args.slice(1);
      if (!teamName || !requestId) {
        throw new Error("usage: agmo team dispatch-ack <team> <request-id>");
      }
      const result = await acknowledgeDispatchRequest(teamName, requestId, cwd);
      printTeamMachineJson("team dispatch-ack", result);
      return;
    }
    case "dispatch-retry": {
      const [teamName, workerName] = args.slice(1);
      if (!teamName) {
        throw new Error("usage: agmo team dispatch-retry <team> [worker]");
      }
      const result = await retryDispatchRequests(teamName, workerName, cwd);
      printTeamMachineJson("team dispatch-retry", result);
      return;
    }
    case "reclaim": {
      const teamName = args[1];
      if (!teamName) {
        throw new Error(
          "usage: agmo team reclaim <team> [--worker <name>] [--task <id>] [--stale-ms <ms>] [--dead-ms <ms>] [--lease-ms <ms>] [--reassign] [--include-stale]"
        );
      }
      const workerName = parseOption(args.slice(2), "--worker");
      const taskId = parseOption(args.slice(2), "--task");
      const staleAfterMs = parseIntegerOption(args.slice(2), "--stale-ms");
      const deadAfterMs = parseIntegerOption(args.slice(2), "--dead-ms");
      const leaseMs = parseIntegerOption(args.slice(2), "--lease-ms");
      assertMinimumOption(staleAfterMs, "--stale-ms", 0);
      assertMinimumOption(deadAfterMs, "--dead-ms", 0);
      assertMinimumOption(leaseMs, "--lease-ms", 0);
      const result = await reclaimTeamClaims(
        teamName,
        {
          workerName,
          taskId,
          staleAfterMs,
          deadAfterMs,
          leaseMs,
          reassign: args.slice(2).includes("--reassign"),
          includeStale: args.slice(2).includes("--include-stale")
        },
        cwd
      );
      printTeamMachineJson("team reclaim", result);
      return;
    }
    case "rebalance": {
      const teamName = args[1];
      if (!teamName) {
        throw new Error(
          "usage: agmo team rebalance <team> [--worker <name>] [--stale-ms <ms>] [--dead-ms <ms>] [--max-open-delta <n>] [--limit <n>] [--strict-role-match] [--allow-busy-workers] [--max-open-per-worker <n>] [--max-pending-dispatch <n>]"
        );
      }
      const workerName = parseOption(args.slice(2), "--worker");
      const staleAfterMs = parseIntegerOption(args.slice(2), "--stale-ms");
      const deadAfterMs = parseIntegerOption(args.slice(2), "--dead-ms");
      const maxOpenDelta = parseIntegerOption(args.slice(2), "--max-open-delta");
      const maxOpenPerWorker = parseIntegerOption(args.slice(2), "--max-open-per-worker");
      const maxPendingDispatch = parseIntegerOption(args.slice(2), "--max-pending-dispatch");
      const limit = parseIntegerOption(args.slice(2), "--limit");
      assertMinimumOption(staleAfterMs, "--stale-ms", 0);
      assertMinimumOption(deadAfterMs, "--dead-ms", 0);
      assertMinimumOption(maxOpenDelta, "--max-open-delta", 0);
      assertMinimumOption(maxOpenPerWorker, "--max-open-per-worker", 0);
      assertMinimumOption(maxPendingDispatch, "--max-pending-dispatch", 0);
      assertMinimumOption(limit, "--limit", 1);
      const result = await rebalanceTeamAssignments(
        teamName,
        {
          workerName,
          staleAfterMs,
          deadAfterMs,
          maxOpenDelta,
          limit,
          strictRoleMatch: args.slice(2).includes("--strict-role-match"),
          allowBusyWorkers: args.slice(2).includes("--allow-busy-workers"),
          maxOpenPerWorker,
          maxPendingDispatch
        },
        cwd
      );
      printTeamMachineJson("team rebalance", result);
      return;
    }
    case "integrate": {
      const teamName = args[1];
      if (!teamName) {
        throw new Error(
          "usage: agmo team integrate <team> [--worker <name>] [--task <id>] [--strategy cherry-pick|squash] [--max-commits <n>] [--batch-size <n>] [--batch-order oldest|newest|task-id] [--target-ref <ref|@base|@current>] [--checkout-target] [--on-conflict continue|stop] [--on-empty skip|fail] [--dry-run]"
        );
      }
      const workerName = parseOption(args.slice(2), "--worker");
      const taskId = parseOption(args.slice(2), "--task");
      const strategy = parseOption(args.slice(2), "--strategy");
      const maxCommits = parseIntegerOption(args.slice(2), "--max-commits");
      const batchSize = parseIntegerOption(args.slice(2), "--batch-size");
      assertMinimumOption(maxCommits, "--max-commits", 1);
      assertMinimumOption(batchSize, "--batch-size", 1);
      const batchOrder = parseOption(args.slice(2), "--batch-order");
      const targetRef = parseOption(args.slice(2), "--target-ref");
      const onConflict = parseOption(args.slice(2), "--on-conflict");
      const onEmpty = parseOption(args.slice(2), "--on-empty");
      if (strategy && !["cherry-pick", "squash"].includes(strategy)) {
        throw new Error("--strategy must be: cherry-pick, squash");
      }
      if (batchOrder && !["oldest", "newest", "task-id"].includes(batchOrder)) {
        throw new Error("--batch-order must be: oldest, newest, task-id");
      }
      if (onConflict && !["continue", "stop"].includes(onConflict)) {
        throw new Error("--on-conflict must be: continue, stop");
      }
      if (onEmpty && !["skip", "fail"].includes(onEmpty)) {
        throw new Error("--on-empty must be: skip, fail");
      }
      const result = await integrateTeamChanges(
        teamName,
        {
          workerName,
          taskId,
          strategy:
            strategy === "cherry-pick" || strategy === "squash" ? strategy : undefined,
          dryRun: args.slice(2).includes("--dry-run"),
          maxCommits,
          batchSize,
          batchOrder:
            batchOrder === "oldest" || batchOrder === "newest" || batchOrder === "task-id"
              ? batchOrder
              : undefined,
          onConflict:
            onConflict === "continue" || onConflict === "stop" ? onConflict : undefined,
          onEmpty: onEmpty === "skip" || onEmpty === "fail" ? onEmpty : undefined,
          targetRef,
          checkoutTarget: args.slice(2).includes("--checkout-target")
        },
        cwd
      );
      printTeamMachineJson("team integrate", result);
      return;
    }
    case "integrate-assist": {
      const teamName = args[1];
      if (!teamName) {
        throw new Error(
          "usage: agmo team integrate-assist <team> [--attempt <id>] [--task <id>]"
        );
      }
      const attemptId = parseOption(args.slice(2), "--attempt");
      const taskId = parseOption(args.slice(2), "--task");
      const result = await readTeamIntegrationAssist(teamName, { attemptId, taskId }, cwd);
      if (!result) {
        throw new Error("integration assist note not found");
      }
      process.stdout.write(result.markdown.endsWith("\n") ? result.markdown : `${result.markdown}\n`);
      return;
    }
    default:
      console.log(`Usage:
  agmo team start <workers> "<task>" [--name <team-name>] [--allocation-intent implementation|verification|planning|knowledge] [--role-map worker-1=agmo-planner,...] [--hud] [--hud-refresh-ms <ms>] [--hud-clear|--hud-no-clear]
  agmo team api <${TEAM_API_OPERATION_USAGE}> --input '<json>' --json
  agmo team status <team-name>
  agmo team shutdown <team-name> [--grace-ms <ms>]
  agmo team delete <team> [--force] [--dry-run] [--keep-worktrees|--remove-worktrees]
  agmo team shutdown-ack <team> <worker> <accepted|busy|rejected> [--reason <text>] [--task <id>]
  agmo team cleanup-stale [--stale-ms <ms>] [--dead-ms <ms>] [--include-stale|--no-include-stale] [--dry-run|--no-dry-run] [--retry-pane-closes|--no-retry-pane-closes] [--sweep-tmux|--no-sweep-tmux]
  agmo team send <team> <worker> "<message>"
  agmo team claim <team> <task-id> <worker> [--ignore-dependencies]
  agmo team complete <team> <task-id> <worker> [result text] [--auto-integrate] [--integrate-strategy cherry-pick|squash] [--integrate-max-commits <n>] [--integrate-target-ref <ref|@base|@current>] [--integrate-checkout-target] [--integrate-on-conflict continue|stop] [--integrate-on-empty skip|fail]
  agmo team fail <team> <task-id> <worker> [error text]
  agmo team heartbeat <team> <worker>
  agmo team report <team> <worker> <idle|working|done|blocked> [--task <id>] [--note <text>]
  agmo team monitor <team> [--preset observe|conservative|balanced|aggressive] [--stale-ms <ms>] [--dead-ms <ms>] [--auto-nudge|--no-auto-nudge] [--nudge-cooldown-ms <ms>] [--auto-reclaim|--no-auto-reclaim] [--auto-reassign|--no-auto-reassign] [--reclaim-lease-ms <ms>] [--include-stale|--no-include-stale] [--escalate-leader|--no-escalate-leader] [--notify-on-stale|--no-notify-on-stale] [--notify-on-dead|--no-notify-on-dead] [--notify-on-claim-risk|--no-notify-on-claim-risk] [--leader-alert-cooldown-ms <ms>] [--escalation-repeat-threshold <n>] [--repair-hud] [--leader-view]
  agmo team alert-delivery show <team>
  agmo team alert-delivery set <team> [--mailbox|--no-mailbox] [--slack|--no-slack] [--slack-webhook-url <url>] [--slack-username <name>] [--slack-icon-emoji <emoji>] [--email|--no-email] [--email-to <a,b>] [--email-from <addr>] [--email-sendmail-path <path>] [--email-subject-prefix <prefix>]
  agmo team hud <team> [--json] [--stale-ms <ms>] [--dead-ms <ms>] [--watch] [--refresh-ms <ms>] [--iterations <n>] [--repair] [--clear|--no-clear] [--preset minimal|sidecar|focused|full] [--width <cols>] [--max-lines <n>] [--legend] [--color|--no-color]
  agmo team layout status <team>
  agmo team layout repair <team> [--dry-run] [--force]
  agmo team layout rebalance <team> [--layout auto|main-vertical|tiled] [--dry-run]
  agmo team dispatch-ack <team> <request-id>
  agmo team dispatch-retry <team> [worker]
  agmo team reclaim <team> [--worker <name>] [--task <id>] [--stale-ms <ms>] [--dead-ms <ms>] [--lease-ms <ms>] [--reassign] [--include-stale]
  agmo team rebalance <team> [--worker <name>] [--stale-ms <ms>] [--dead-ms <ms>] [--max-open-delta <n>] [--limit <n>] [--strict-role-match] [--allow-busy-workers] [--max-open-per-worker <n>] [--max-pending-dispatch <n>]
  agmo team integrate <team> [--worker <name>] [--task <id>] [--strategy cherry-pick|squash] [--max-commits <n>] [--batch-size <n>] [--batch-order oldest|newest|task-id] [--target-ref <ref|@base|@current>] [--checkout-target] [--on-conflict continue|stop] [--on-empty skip|fail] [--dry-run]
  agmo team integrate-assist <team> [--attempt <id>] [--task <id>]`);
      process.exitCode = 1;
  }
}
