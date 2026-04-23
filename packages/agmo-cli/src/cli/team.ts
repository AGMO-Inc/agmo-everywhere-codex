import {
  buildLeaderHudView,
  autoNudgeTeamRuntime,
  acknowledgeDispatchRequest,
  buildLeaderMonitorView,
  configureLeaderAlertDelivery,
  deliverLeaderAlerts,
  evaluateLeaderEscalations,
  rebalanceTeamAssignments,
  claimTaskForWorker,
  cleanupStaleTeamRuntimes,
  completeTaskForWorker,
  failTaskForWorker,
  heartbeatWorker,
  integrateTeamChanges,
  monitorTeamRuntime,
  resolveMonitorPolicy,
  reclaimTeamClaims,
  readTeamStatus,
  readTeamIntegrationAssist,
  reportWorkerStatus,
  retryDispatchRequests,
  sendWorkerMessage,
  showLeaderAlertDeliveryConfig,
  shutdownTeamRuntime,
  startTeamRuntime
} from "../team/runtime.js";
import { resolveTeamMonitorPolicyPath } from "../team/state/index.js";
import { parseScopeFlag } from "../utils/args.js";
import { resolveRuntimeRoot } from "../utils/paths.js";
import { writeJsonFile } from "../utils/fs.js";

function parseWorkerCount(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(parsed)) {
    throw new Error("worker count must be an integer");
  }
  return parsed;
}

function parseIntegerOption(args: string[], optionName: string): number | undefined {
  const raw = parseOption(args, optionName);
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${optionName} must be an integer`);
  }

  return parsed;
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
    output[workerName] = role;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseOption(args: string[], optionName: string): string | undefined {
  const exactIndex = args.findIndex((arg) => arg === optionName);
  if (exactIndex >= 0) {
    return args[exactIndex + 1];
  }

  const inline = args.find((arg) => arg.startsWith(`${optionName}=`));
  return inline ? inline.slice(optionName.length + 1) : undefined;
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
    case "start": {
      parseScopeFlag(args.slice(1));
      const workers = parseWorkerCount(args[1]);
      const hudRefreshMs = parseIntegerOption(args.slice(2), "--hud-refresh-ms");
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
      console.log(
        JSON.stringify(
          { command: "team start", ...result },
          null,
          2
        )
      );
      return;
    }
    case "status": {
      const teamName = args[1];
      if (!teamName) {
        throw new Error("team name is required");
      }
      const status = await readTeamStatus(teamName, cwd);
      console.log(
        JSON.stringify(
          {
            command: "team status",
            team_name: teamName,
            found: Boolean(status),
            status
          },
          null,
          2
        )
      );
      return;
    }
    case "shutdown": {
      const teamName = args[1];
      if (!teamName) {
        throw new Error("team name is required");
      }
      const result = await shutdownTeamRuntime(teamName, cwd);
      console.log(
        JSON.stringify(
          { command: "team shutdown", ...result },
          null,
          2
        )
      );
      return;
    }
    case "cleanup-stale": {
      const staleAfterMs = parseIntegerOption(args.slice(1), "--stale-ms");
      const deadAfterMs = parseIntegerOption(args.slice(1), "--dead-ms");
      const includeStale = parseBooleanFlag(
        args.slice(1),
        "--include-stale",
        "--no-include-stale"
      );
      const dryRun = parseBooleanFlag(args.slice(1), "--dry-run", "--no-dry-run");
      const result = await cleanupStaleTeamRuntimes(
        {
          staleAfterMs,
          deadAfterMs,
          includeStale,
          dryRun
        },
        cwd
      );
      console.log(JSON.stringify({ command: "team cleanup-stale", ...result }, null, 2));
      return;
    }
    case "send": {
      const [teamName, workerName, ...messageParts] = args.slice(1);
      const message = messageParts.join(" ").trim();
      if (!teamName || !workerName || !message) {
        throw new Error("usage: agmo team send <team> <worker> \"<message>\"");
      }
      const result = await sendWorkerMessage(teamName, workerName, message, cwd);
      console.log(JSON.stringify({ command: "team send", ...result }, null, 2));
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
      console.log(JSON.stringify({ command: "team claim", ...result }, null, 2));
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
      console.log(
        JSON.stringify(
          {
            command: "team complete",
            ...result,
            ...(integration ? { integration } : {})
          },
          null,
          2
        )
      );
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
      console.log(JSON.stringify({ command: "team fail", ...result }, null, 2));
      return;
    }
    case "heartbeat": {
      const [teamName, workerName] = args.slice(1);
      if (!teamName || !workerName) {
        throw new Error("usage: agmo team heartbeat <team> <worker>");
      }
      const result = await heartbeatWorker(teamName, workerName, cwd);
      console.log(JSON.stringify({ command: "team heartbeat", ...result }, null, 2));
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
      console.log(JSON.stringify({ command: "team report", ...result }, null, 2));
      return;
    }
    case "monitor": {
      const teamName = args[1];
      if (!teamName) {
        throw new Error(
          "usage: agmo team monitor <team> [--preset observe|conservative|balanced|aggressive] [--stale-ms <ms>] [--dead-ms <ms>] [--auto-nudge|--no-auto-nudge] [--nudge-cooldown-ms <ms>] [--auto-reclaim|--no-auto-reclaim] [--auto-reassign|--no-auto-reassign] [--reclaim-lease-ms <ms>] [--include-stale|--no-include-stale] [--escalate-leader|--no-escalate-leader] [--notify-on-stale|--no-notify-on-stale] [--notify-on-dead|--no-notify-on-dead] [--notify-on-claim-risk|--no-notify-on-claim-risk] [--leader-alert-cooldown-ms <ms>] [--escalation-repeat-threshold <n>] [--leader-view]"
        );
      }
      const preset = parseOption(args.slice(2), "--preset");
      const staleRaw = parseOption(args.slice(2), "--stale-ms");
      const deadRaw = parseOption(args.slice(2), "--dead-ms");
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
      const cooldownRaw = parseOption(args.slice(2), "--nudge-cooldown-ms");
      const reclaimLeaseRaw = parseOption(args.slice(2), "--reclaim-lease-ms");
      const leaderAlertCooldownRaw = parseOption(args.slice(2), "--leader-alert-cooldown-ms");
      const escalationRepeatThresholdRaw = parseOption(
        args.slice(2),
        "--escalation-repeat-threshold"
      );
      const staleAfterMs = staleRaw ? Number.parseInt(staleRaw, 10) : undefined;
      const deadAfterMs = deadRaw ? Number.parseInt(deadRaw, 10) : undefined;
      const cooldownMs = cooldownRaw ? Number.parseInt(cooldownRaw, 10) : undefined;
      const reclaimLeaseMs = reclaimLeaseRaw
        ? Number.parseInt(reclaimLeaseRaw, 10)
        : undefined;
      const leaderAlertCooldownMs = leaderAlertCooldownRaw
        ? Number.parseInt(leaderAlertCooldownRaw, 10)
        : undefined;
      const escalationRepeatThreshold = escalationRepeatThresholdRaw
        ? Number.parseInt(escalationRepeatThresholdRaw, 10)
        : undefined;
      if (
        preset &&
        !["observe", "conservative", "balanced", "aggressive"].includes(preset)
      ) {
        throw new Error("--preset must be: observe, conservative, balanced, aggressive");
      }
      if (staleRaw && !Number.isFinite(staleAfterMs)) {
        throw new Error("--stale-ms must be an integer");
      }
      if (deadRaw && !Number.isFinite(deadAfterMs)) {
        throw new Error("--dead-ms must be an integer");
      }
      if (cooldownRaw && !Number.isFinite(cooldownMs)) {
        throw new Error("--nudge-cooldown-ms must be an integer");
      }
      if (reclaimLeaseRaw && !Number.isFinite(reclaimLeaseMs)) {
        throw new Error("--reclaim-lease-ms must be an integer");
      }
      if (leaderAlertCooldownRaw && !Number.isFinite(leaderAlertCooldownMs)) {
        throw new Error("--leader-alert-cooldown-ms must be an integer");
      }
      if (
        escalationRepeatThresholdRaw &&
        !Number.isFinite(escalationRepeatThreshold)
      ) {
        throw new Error("--escalation-repeat-threshold must be an integer");
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
      const finalSnapshot = autoRecovery
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
        console.log(
          JSON.stringify(
            {
              command: "team monitor",
              policy: effectivePolicy,
              snapshot: finalSnapshot,
              ...(leaderAlerts ? { leader_alerts: leaderAlerts.alerts } : {}),
              ...(leaderAlertDelivery
                ? { leader_alert_delivery: leaderAlertDelivery }
                : {}),
              ...(autoNudges ? { auto_nudges: autoNudges.nudges } : {}),
              ...(autoRecovery ? { auto_recovery: autoRecovery.reclaimed } : {})
            },
            null,
            2
          )
        );
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
        console.log(
          JSON.stringify({ command: "team alert-delivery show", ...result }, null, 2)
        );
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
        console.log(
          JSON.stringify({ command: "team alert-delivery set", ...result }, null, 2)
        );
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
          "usage: agmo team hud <team> [--stale-ms <ms>] [--dead-ms <ms>] [--watch] [--refresh-ms <ms>] [--clear|--no-clear]"
        );
      }
      const staleRaw = parseOption(args.slice(2), "--stale-ms");
      const deadRaw = parseOption(args.slice(2), "--dead-ms");
      const refreshMs = parseIntegerOption(args.slice(2), "--refresh-ms");
      const iterations = parseIntegerOption(args.slice(2), "--iterations");
      const clearScreen = parseBooleanFlag(args.slice(2), "--clear", "--no-clear") ?? true;
      const watch = args.slice(2).includes("--watch");
      const staleAfterMs = staleRaw ? Number.parseInt(staleRaw, 10) : undefined;
      const deadAfterMs = deadRaw ? Number.parseInt(deadRaw, 10) : undefined;
      if (staleRaw && !Number.isFinite(staleAfterMs)) {
        throw new Error("--stale-ms must be an integer");
      }
      if (deadRaw && !Number.isFinite(deadAfterMs)) {
        throw new Error("--dead-ms must be an integer");
      }
      if (refreshMs !== undefined && refreshMs < 250) {
        throw new Error("--refresh-ms must be at least 250");
      }
      if (iterations !== undefined && iterations < 1) {
        throw new Error("--iterations must be at least 1");
      }
      const runHudOnce = async (): Promise<void> => {
        const hud = await buildLeaderHudView(
          teamName,
          { staleAfterMs, deadAfterMs },
          cwd
        );
        if (watch && clearScreen) {
          process.stdout.write("\u001bc");
        }
        process.stdout.write(`${hud.text}\n`);
      };
      if (watch) {
        const intervalMs = refreshMs ?? 2000;
        const maxIterations = iterations ?? Number.POSITIVE_INFINITY;
        for (let index = 0; index < maxIterations; index += 1) {
          await runHudOnce();
          if (index + 1 < maxIterations) {
            await sleep(intervalMs);
          }
        }
      } else {
        await runHudOnce();
      }
      return;
    }
    case "dispatch-ack": {
      const [teamName, requestId] = args.slice(1);
      if (!teamName || !requestId) {
        throw new Error("usage: agmo team dispatch-ack <team> <request-id>");
      }
      const result = await acknowledgeDispatchRequest(teamName, requestId, cwd);
      console.log(JSON.stringify({ command: "team dispatch-ack", ...result }, null, 2));
      return;
    }
    case "dispatch-retry": {
      const [teamName, workerName] = args.slice(1);
      if (!teamName) {
        throw new Error("usage: agmo team dispatch-retry <team> [worker]");
      }
      const result = await retryDispatchRequests(teamName, workerName, cwd);
      console.log(JSON.stringify({ command: "team dispatch-retry", ...result }, null, 2));
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
      const staleRaw = parseOption(args.slice(2), "--stale-ms");
      const deadRaw = parseOption(args.slice(2), "--dead-ms");
      const leaseRaw = parseOption(args.slice(2), "--lease-ms");
      const staleAfterMs = staleRaw ? Number.parseInt(staleRaw, 10) : undefined;
      const deadAfterMs = deadRaw ? Number.parseInt(deadRaw, 10) : undefined;
      const leaseMs = leaseRaw ? Number.parseInt(leaseRaw, 10) : undefined;
      if (staleRaw && !Number.isFinite(staleAfterMs)) {
        throw new Error("--stale-ms must be an integer");
      }
      if (deadRaw && !Number.isFinite(deadAfterMs)) {
        throw new Error("--dead-ms must be an integer");
      }
      if (leaseRaw && !Number.isFinite(leaseMs)) {
        throw new Error("--lease-ms must be an integer");
      }
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
      console.log(JSON.stringify({ command: "team reclaim", ...result }, null, 2));
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
      const staleRaw = parseOption(args.slice(2), "--stale-ms");
      const deadRaw = parseOption(args.slice(2), "--dead-ms");
      const maxOpenDeltaRaw = parseOption(args.slice(2), "--max-open-delta");
      const maxOpenPerWorkerRaw = parseOption(args.slice(2), "--max-open-per-worker");
      const maxPendingDispatchRaw = parseOption(args.slice(2), "--max-pending-dispatch");
      const limitRaw = parseOption(args.slice(2), "--limit");
      const staleAfterMs = staleRaw ? Number.parseInt(staleRaw, 10) : undefined;
      const deadAfterMs = deadRaw ? Number.parseInt(deadRaw, 10) : undefined;
      const maxOpenDelta = maxOpenDeltaRaw
        ? Number.parseInt(maxOpenDeltaRaw, 10)
        : undefined;
      const maxOpenPerWorker = maxOpenPerWorkerRaw
        ? Number.parseInt(maxOpenPerWorkerRaw, 10)
        : undefined;
      const maxPendingDispatch = maxPendingDispatchRaw
        ? Number.parseInt(maxPendingDispatchRaw, 10)
        : undefined;
      const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
      if (staleRaw && !Number.isFinite(staleAfterMs)) {
        throw new Error("--stale-ms must be an integer");
      }
      if (deadRaw && !Number.isFinite(deadAfterMs)) {
        throw new Error("--dead-ms must be an integer");
      }
      if (maxOpenDeltaRaw && !Number.isFinite(maxOpenDelta)) {
        throw new Error("--max-open-delta must be an integer");
      }
      if (maxOpenPerWorkerRaw && !Number.isFinite(maxOpenPerWorker)) {
        throw new Error("--max-open-per-worker must be an integer");
      }
      if (maxPendingDispatchRaw && !Number.isFinite(maxPendingDispatch)) {
        throw new Error("--max-pending-dispatch must be an integer");
      }
      if (limitRaw && !Number.isFinite(limit)) {
        throw new Error("--limit must be an integer");
      }
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
      console.log(JSON.stringify({ command: "team rebalance", ...result }, null, 2));
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
      const batchOrder = parseOption(args.slice(2), "--batch-order");
      const targetRef = parseOption(args.slice(2), "--target-ref");
      const onConflict = parseOption(args.slice(2), "--on-conflict");
      const onEmpty = parseOption(args.slice(2), "--on-empty");
      if (strategy && !["cherry-pick", "squash"].includes(strategy)) {
        throw new Error("--strategy must be: cherry-pick, squash");
      }
      if (batchSize !== undefined && batchSize < 1) {
        throw new Error("--batch-size must be at least 1");
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
      console.log(JSON.stringify({ command: "team integrate", ...result }, null, 2));
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
  agmo team status <team-name>
  agmo team shutdown <team-name>
  agmo team cleanup-stale [--stale-ms <ms>] [--dead-ms <ms>] [--include-stale|--no-include-stale] [--dry-run|--no-dry-run]
  agmo team send <team> <worker> "<message>"
  agmo team claim <team> <task-id> <worker> [--ignore-dependencies]
  agmo team complete <team> <task-id> <worker> [result text] [--auto-integrate] [--integrate-strategy cherry-pick|squash] [--integrate-max-commits <n>] [--integrate-target-ref <ref|@base|@current>] [--integrate-checkout-target] [--integrate-on-conflict continue|stop] [--integrate-on-empty skip|fail]
  agmo team fail <team> <task-id> <worker> [error text]
  agmo team heartbeat <team> <worker>
  agmo team report <team> <worker> <idle|working|done|blocked> [--task <id>] [--note <text>]
  agmo team monitor <team> [--preset observe|conservative|balanced|aggressive] [--stale-ms <ms>] [--dead-ms <ms>] [--auto-nudge|--no-auto-nudge] [--nudge-cooldown-ms <ms>] [--auto-reclaim|--no-auto-reclaim] [--auto-reassign|--no-auto-reassign] [--reclaim-lease-ms <ms>] [--include-stale|--no-include-stale] [--escalate-leader|--no-escalate-leader] [--notify-on-stale|--no-notify-on-stale] [--notify-on-dead|--no-notify-on-dead] [--notify-on-claim-risk|--no-notify-on-claim-risk] [--leader-alert-cooldown-ms <ms>] [--escalation-repeat-threshold <n>] [--leader-view]
  agmo team alert-delivery show <team>
  agmo team alert-delivery set <team> [--mailbox|--no-mailbox] [--slack|--no-slack] [--slack-webhook-url <url>] [--slack-username <name>] [--slack-icon-emoji <emoji>] [--email|--no-email] [--email-to <a,b>] [--email-from <addr>] [--email-sendmail-path <path>] [--email-subject-prefix <prefix>]
  agmo team hud <team> [--stale-ms <ms>] [--dead-ms <ms>] [--watch] [--refresh-ms <ms>] [--clear|--no-clear]
  agmo team dispatch-ack <team> <request-id>
  agmo team dispatch-retry <team> [worker]
  agmo team reclaim <team> [--worker <name>] [--task <id>] [--stale-ms <ms>] [--dead-ms <ms>] [--lease-ms <ms>] [--reassign] [--include-stale]
  agmo team rebalance <team> [--worker <name>] [--stale-ms <ms>] [--dead-ms <ms>] [--max-open-delta <n>] [--limit <n>] [--strict-role-match] [--allow-busy-workers] [--max-open-per-worker <n>] [--max-pending-dispatch <n>]
  agmo team integrate <team> [--worker <name>] [--task <id>] [--strategy cherry-pick|squash] [--max-commits <n>] [--batch-size <n>] [--batch-order oldest|newest|task-id] [--target-ref <ref|@base|@current>] [--checkout-target] [--on-conflict continue|stop] [--on-empty skip|fail] [--dry-run]
  agmo team integrate-assist <team> [--attempt <id>] [--task <id>]`);
      process.exitCode = 1;
  }
}
