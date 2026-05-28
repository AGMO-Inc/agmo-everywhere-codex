import type { AgmoTeamStatusSnapshot } from "./state/index.js";
import type { AgmoTeamMonitorSnapshot } from "./state/monitor.js";
import {
  colorize,
  fitLines,
  resolveColorEnabled,
  sanitizeTerminalText,
  type AgmoColorMode
} from "./terminal-format.js";

export type AgmoTeamHudPreset = "minimal" | "sidecar" | "focused" | "full";

export type TeamHudActionKey =
  | "leader-orphan"
  | "repair-hud"
  | "layout-repair"
  | "layout-rebalance"
  | "nudge"
  | "reclaim"
  | "task-rebalance"
  | "retry-dispatch"
  | "alert";

export type TeamHudActionSeverity = "critical" | "warning" | "info";

export type TeamHudSuggestedAction = {
  key: TeamHudActionKey;
  label: string;
  reason: string;
  severity: TeamHudActionSeverity;
  command?: string;
  mutating?: boolean;
};

export type TeamHudRenderContext = {
  teamName: string;
  snapshot: AgmoTeamMonitorSnapshot;
  status: AgmoTeamStatusSnapshot;
  taskCounts: Record<"pending" | "in_progress" | "blocked" | "completed" | "failed", number>;
  pendingDispatch: number;
  activeLeaderAlerts: number;
  openLoads: Record<string, number>;
  openLoadDelta: number;
  topActions: string[];
  suggestedActions?: TeamHudSuggestedAction[];
};

export type TeamHudRenderOptions = {
  preset?: AgmoTeamHudPreset;
  maxWidth?: number;
  maxLines?: number;
  color?: AgmoColorMode;
  showLegend?: boolean;
};

const ACTION_KEY_PRIORITY: TeamHudActionKey[] = [
  "leader-orphan",
  "repair-hud",
  "layout-repair",
  "reclaim",
  "nudge",
  "retry-dispatch",
  "layout-rebalance",
  "task-rebalance",
  "alert"
];

const ACTION_SEVERITY_PRIORITY: TeamHudActionSeverity[] = ["critical", "warning", "info"];

const LEGACY_ACTION_KEY_MAP: Record<string, TeamHudActionKey> = {
  "leader-orphan": "leader-orphan",
  "repair-hud": "repair-hud",
  "layout-repair": "layout-repair",
  "layout-rebalance": "layout-rebalance",
  nudge: "nudge",
  reclaim: "reclaim",
  rebalance: "task-rebalance",
  "task-rebalance": "task-rebalance",
  "retry-dispatch": "retry-dispatch",
  alert: "alert"
};

const DEFAULT_ACTIONS: Record<TeamHudActionKey, TeamHudSuggestedAction> = {
  "leader-orphan": {
    key: "leader-orphan",
    label: "Leader pane orphaned",
    reason: "leader tmux pane is unavailable",
    severity: "critical"
  },
  "repair-hud": {
    key: "repair-hud",
    label: "Repair HUD pane",
    reason: "HUD tmux pane is unavailable",
    severity: "critical"
  },
  "layout-repair": {
    key: "layout-repair",
    label: "Repair layout",
    reason: "tmux layout is repairable",
    severity: "critical"
  },
  "layout-rebalance": {
    key: "layout-rebalance",
    label: "Rebalance layout",
    reason: "tmux layout is degraded",
    severity: "warning"
  },
  nudge: {
    key: "nudge",
    label: "Nudge workers",
    reason: "workers are stale or dead",
    severity: "warning"
  },
  reclaim: {
    key: "reclaim",
    label: "Reclaim task claims",
    reason: "task claims are at risk",
    severity: "critical"
  },
  "task-rebalance": {
    key: "task-rebalance",
    label: "Rebalance tasks",
    reason: "open task load is uneven",
    severity: "warning"
  },
  "retry-dispatch": {
    key: "retry-dispatch",
    label: "Retry dispatch",
    reason: "dispatch requests are pending",
    severity: "warning"
  },
  alert: {
    key: "alert",
    label: "Review alerts",
    reason: "leader alerts are active",
    severity: "info"
  }
};

const LEGEND_LINE =
  "Legend: h=healthy s=stale d=dead p=pending w=working b=blocked c=completed f=failed t=task d=dispatch !=claim-risk";

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "unknown";
  }
  if (ms < 1000) {
    return `${Math.floor(ms)}ms`;
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function clean(value: unknown): string {
  return sanitizeTerminalText(value);
}

export function buildTeamHudRenderContext(
  teamName: string,
  snapshot: AgmoTeamMonitorSnapshot,
  status: AgmoTeamStatusSnapshot,
  values: {
    taskCounts: TeamHudRenderContext["taskCounts"];
    pendingDispatch: number;
    activeLeaderAlerts: number;
    openLoads: Map<string, number>;
    openLoadDelta: number;
    topActions: string[];
    suggestedActions?: TeamHudSuggestedAction[];
  }
): TeamHudRenderContext {
  return {
    teamName,
    snapshot,
    status,
    taskCounts: values.taskCounts,
    pendingDispatch: values.pendingDispatch,
    activeLeaderAlerts: values.activeLeaderAlerts,
    openLoads: Object.fromEntries(values.openLoads.entries()),
    openLoadDelta: values.openLoadDelta,
    topActions: [...values.topActions],
    suggestedActions: values.suggestedActions ? [...values.suggestedActions] : undefined
  };
}

function actionPriority(action: TeamHudSuggestedAction): number {
  return (
    ACTION_SEVERITY_PRIORITY.indexOf(action.severity) * ACTION_KEY_PRIORITY.length +
    ACTION_KEY_PRIORITY.indexOf(action.key)
  );
}

function normalizeAction(action: TeamHudSuggestedAction): TeamHudSuggestedAction {
  const fallback = DEFAULT_ACTIONS[action.key];
  return {
    ...fallback,
    ...action,
    label: action.label || fallback.label,
    reason: action.reason || fallback.reason,
    severity: action.severity || fallback.severity
  };
}

function legacyActionToSuggestedAction(action: string): TeamHudSuggestedAction | null {
  const key = LEGACY_ACTION_KEY_MAP[action];
  return key ? DEFAULT_ACTIONS[key] : null;
}

function resolveSuggestedActions(context: TeamHudRenderContext): TeamHudSuggestedAction[] {
  const rawActions =
    context.suggestedActions && context.suggestedActions.length > 0
      ? context.suggestedActions.map(normalizeAction)
      : context.topActions.map(legacyActionToSuggestedAction).filter((action) => action !== null);
  const byKey = new Map<TeamHudActionKey, TeamHudSuggestedAction>();
  for (const action of rawActions) {
    const existing = byKey.get(action.key);
    if (!existing || actionPriority(action) < actionPriority(existing)) {
      byKey.set(action.key, action);
    }
  }
  return [...byKey.values()].sort((left, right) => actionPriority(left) - actionPriority(right));
}

function resolveActionCommand(
  action: TeamHudSuggestedAction,
  preset: "focused" | "full",
  teamName: string
): { command: string; mutating: boolean } | null {
  const safeCommands: Partial<Record<TeamHudActionKey, string>> = {
    "leader-orphan": "agmo team cleanup-stale --sweep-tmux --dry-run",
    "repair-hud": `agmo team layout repair ${teamName} --dry-run`,
    "layout-repair": `agmo team layout repair ${teamName} --dry-run`,
    "layout-rebalance": `agmo team layout rebalance ${teamName} --dry-run`,
    alert: `agmo team alert-delivery show ${teamName}`
  };
  const fullCommands: Partial<Record<TeamHudActionKey, { command: string; mutating: boolean }>> = {
    "leader-orphan": {
      command: "agmo team cleanup-stale --sweep-tmux --dry-run",
      mutating: false
    },
    "repair-hud": { command: `agmo team layout repair ${teamName}`, mutating: true },
    "layout-repair": { command: `agmo team layout repair ${teamName}`, mutating: true },
    "layout-rebalance": { command: `agmo team layout rebalance ${teamName}`, mutating: true },
    reclaim: { command: `agmo team reclaim ${teamName} --reassign`, mutating: true },
    nudge: { command: `agmo team monitor ${teamName} --auto-nudge`, mutating: true },
    "retry-dispatch": { command: `agmo team dispatch-retry ${teamName}`, mutating: true },
    "task-rebalance": { command: `agmo team rebalance ${teamName}`, mutating: true },
    alert: { command: `agmo team alert-delivery show ${teamName}`, mutating: false }
  };

  if (preset === "focused") {
    const command = safeCommands[action.key];
    return command ? { command, mutating: false } : null;
  }

  return (
    fullCommands[action.key] ??
    (action.command ? { command: action.command, mutating: Boolean(action.mutating) } : null)
  );
}

function formatActionLine(
  action: TeamHudSuggestedAction,
  preset: "focused" | "full",
  teamName: string
): string {
  const command = resolveActionCommand(action, preset, teamName);
  const commandSuffix = command
    ? ` | ${command.mutating ? "manual:" : "cmd:"} ${clean(command.command)}`
    : "";
  return `- ${action.key} [${action.severity}] ${clean(action.label)}: ${clean(action.reason)}${commandSuffix}`;
}

function formatSidecarActionLine(action: TeamHudSuggestedAction): string {
  return `${action.key}:${action.severity}(${clean(action.reason)})`;
}

function formatSidecarWorkerStrip(context: TeamHudRenderContext): string {
  const workers = [...context.snapshot.workers].sort((left, right) =>
    left.worker_name.localeCompare(right.worker_name, undefined, { numeric: true })
  );
  if (workers.length === 0) {
    return "workers none";
  }
  const workerTokens = workers.map((worker) => {
    const load = context.openLoads[worker.worker_name] ?? 0;
    const health =
      worker.health === "healthy" ? "h" : worker.health === "stale" ? "s" : worker.health === "dead" ? "d" : "?";
    const currentTask = worker.current_task_id ? ` t=${clean(worker.current_task_id)}` : "";
    const dispatch = worker.pending_dispatch_count > 0 ? ` d=${worker.pending_dispatch_count}` : "";
    const risk = worker.claim_at_risk ? " !" : "";
    return `${clean(worker.worker_name)}:${health}/${clean(worker.status_state)} open=${load}${currentTask}${dispatch}${risk}`;
  });
  return `workers ${workerTokens.join(" ; ")}`;
}

function formatSidecarTaskSignal(context: TeamHudRenderContext): string | null {
  const currentTasks = context.status.tasks
    .filter((task) => ["in_progress", "blocked", "pending"].includes(task.status))
    .sort((left, right) => {
      const statusPriority = (status: string): number =>
        status === "blocked" ? 0 : status === "in_progress" ? 1 : 2;
      return (
        statusPriority(left.status) - statusPriority(right.status) ||
        left.id.localeCompare(right.id, undefined, { numeric: true })
      );
    });
  const task = currentTasks[0];
  if (!task) {
    return null;
  }
  const owner = task.owner ? clean(task.owner) : "unassigned";
  return `task ${clean(task.id)}:${clean(task.status)} owner=${owner} ${clean(task.subject)}`;
}

export function renderTeamHud(
  context: TeamHudRenderContext,
  options: TeamHudRenderOptions = {}
): string {
  const preset = options.preset ?? "focused";
  const width = Math.max(20, Math.floor(options.maxWidth ?? 100));
  const color = resolveColorEnabled(options.color);
  const c = (value: string, tone: "bold" | "dim" | "green" | "yellow" | "red" | "cyan") =>
    colorize(value, tone, color);
  const { snapshot, taskCounts } = context;
  const suggestedActions = resolveSuggestedActions(context);
  const actions =
    suggestedActions.length > 0 ? suggestedActions.map((action) => action.key).join(",") : "none";
  const layoutHealth = snapshot.layout_health ?? snapshot.tmux_health?.layout ?? "unknown";
  const retryParts =
    snapshot.tmux_health === undefined
      ? []
      : [
          snapshot.tmux_health.retry_pending > 0
            ? `retry_pending=${snapshot.tmux_health.retry_pending}`
            : null,
          snapshot.tmux_health.retry_manual_required > 0
            ? `retry_manual=${snapshot.tmux_health.retry_manual_required}`
            : null
        ].filter((part): part is string => part !== null);
  const retryCounts = retryParts.length > 0 ? ` | ${retryParts.join(" ")}` : "";
  const lines: string[] = [
    `${c("AGMO HUD", "bold")} | team=${clean(context.teamName)} | checked=${clean(snapshot.checked_at)}`,
    `workers h=${snapshot.healthy_workers} s=${snapshot.stale_workers} d=${snapshot.dead_workers} active=${snapshot.active_workers} | tasks p=${taskCounts.pending} w=${taskCounts.in_progress} b=${taskCounts.blocked} c=${taskCounts.completed} f=${taskCounts.failed}`,
    `tmux leader=${snapshot.leader?.health ?? "n/a"} hud=${snapshot.hud?.health ?? "n/a"} layout=${layoutHealth}${retryCounts} | dispatch_pending=${context.pendingDispatch} | open_load_delta=${context.openLoadDelta} | actions=${actions}`
  ];

  if (options.showLegend) {
    lines.push(LEGEND_LINE);
  }

  if (preset === "minimal") {
    return `${fitLines(lines, width, options.maxLines).join("\n")}\n`;
  }

  if (preset === "sidecar") {
    const sidecarLines = [
      `${c("AGMO sidecar", "bold")} team=${clean(context.teamName)} checked=${clean(snapshot.checked_at)}`,
      `health workers h/s/d=${snapshot.healthy_workers}/${snapshot.stale_workers}/${snapshot.dead_workers} active=${snapshot.active_workers} | tasks p/w/b/c/f=${taskCounts.pending}/${taskCounts.in_progress}/${taskCounts.blocked}/${taskCounts.completed}/${taskCounts.failed}`,
      `tmux leader=${snapshot.leader?.health ?? "n/a"} hud=${snapshot.hud?.health ?? "n/a"} layout=${layoutHealth}${retryCounts} | dispatch=${context.pendingDispatch} | delta=${context.openLoadDelta}`,
      formatSidecarWorkerStrip(context)
    ];
    const taskSignal = formatSidecarTaskSignal(context);
    if (taskSignal) {
      sidecarLines.push(taskSignal);
    }
    if (suggestedActions.length > 0) {
      const actionSummary = suggestedActions
        .slice(0, 3)
        .map(formatSidecarActionLine)
        .join(" | ");
      sidecarLines.push(`${c("actions", "cyan")} ${actionSummary}`);
    }
    return `${fitLines(sidecarLines, width, options.maxLines ?? 6).join("\n")}\n`;
  }

  const actionLimit = preset === "full" ? 5 : 3;
  if (suggestedActions.length > 0) {
    lines.push("");
    lines.push(c("Actions", "cyan"));
    for (const action of suggestedActions.slice(0, actionLimit)) {
      lines.push(formatActionLine(action, preset, context.teamName));
    }
  }

  const workers = [...snapshot.workers].sort((left, right) =>
    left.worker_name.localeCompare(right.worker_name, undefined, { numeric: true })
  );
  lines.push("");
  lines.push(c("Workers", "cyan"));
  if (workers.length === 0) {
    lines.push("no workers");
  } else {
    for (const worker of workers) {
      const load = context.openLoads[worker.worker_name] ?? 0;
      const healthTone =
        worker.health === "healthy" ? "green" : worker.health === "stale" ? "yellow" : "red";
      const currentTask = worker.current_task_id ? ` t=${clean(worker.current_task_id)}` : "";
      const dispatch = worker.pending_dispatch_count > 0 ? ` d=${worker.pending_dispatch_count}` : "";
      const risk = worker.claim_at_risk ? " !" : "";
      lines.push(
        `${clean(worker.worker_name).padEnd(8)} ${c(worker.health.padEnd(7), healthTone)} ${clean(worker.status_state).padEnd(7)} open=${String(load).padEnd(2)} hb=${formatDurationMs(worker.ms_since_heartbeat).padEnd(6)}${currentTask}${dispatch}${risk}`
      );
    }
  }

  if (preset === "full") {
    const openTasks = context.status.tasks
      .filter((task) => ["pending", "in_progress", "blocked"].includes(task.status))
      .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
    lines.push("");
    lines.push(c("Open Tasks", "cyan"));
    if (openTasks.length === 0) {
      lines.push("none");
    } else {
      for (const task of openTasks) {
        lines.push(
          `task ${clean(task.id)} | ${clean(task.status)} | owner=${clean(task.owner ?? "unassigned")} | ${clean(task.subject)}`
        );
      }
    }
  }

  return `${fitLines(lines, width, options.maxLines).join("\n")}\n`;
}
