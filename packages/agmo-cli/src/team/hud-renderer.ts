import type { AgmoTeamStatusSnapshot } from "./state/index.js";
import type { AgmoTeamMonitorSnapshot } from "./state/monitor.js";
import {
  colorize,
  ellipsize,
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

export type TeamHudRecentEvent = {
  eventId?: string;
  type: string;
  sourceType?: string;
  worker?: string;
  taskId?: string;
  state?: string;
  reason?: string;
  createdAt?: string;
};

type TeamHudHighlight = {
  severity: TeamHudActionSeverity;
  target: string;
  message: string;
};

type TeamHudInspectHint = {
  severity: TeamHudActionSeverity;
  key: string;
  command: string;
  metadata: Record<string, string>;
  reason: string;
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
  recentEvents?: TeamHudRecentEvent[];
};

export type TeamHudRenderOptions = {
  preset?: AgmoTeamHudPreset;
  maxWidth?: number;
  maxLines?: number;
  color?: AgmoColorMode;
  showLegend?: boolean;
};

type TeamHudWorkerSnapshot = TeamHudRenderContext["snapshot"]["workers"][number];
type TeamHudTaskSnapshot = TeamHudRenderContext["status"]["tasks"][number];
type TeamHudColorTone = "bold" | "dim" | "green" | "yellow" | "red" | "cyan";
type TeamHudColorize = (value: string, tone: TeamHudColorTone) => string;

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
    recentEvents?: TeamHudRecentEvent[];
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
    suggestedActions: values.suggestedActions ? [...values.suggestedActions] : undefined,
    recentEvents: values.recentEvents ? [...values.recentEvents] : undefined
  };
}

function actionPriority(action: TeamHudSuggestedAction): number {
  return (
    ACTION_SEVERITY_PRIORITY.indexOf(action.severity) * ACTION_KEY_PRIORITY.length +
    ACTION_KEY_PRIORITY.indexOf(action.key)
  );
}

function highlightPriority(highlight: TeamHudHighlight): number {
  return ACTION_SEVERITY_PRIORITY.indexOf(highlight.severity);
}

function inspectHintPriority(hint: TeamHudInspectHint): number {
  const keyPriority: Record<string, number> = {
    "layout-repairable": 0,
    "leader-pane": 1,
    "hud-pane": 2,
    "worker-dead": 3,
    "claim-risk": 4,
    "task-failed": 5,
    "worker-stale": 6,
    "worker-blocked": 7,
    "task-blocked": 8,
    "layout-degraded": 9,
    "worktree-diagnostics": 10
  };
  return ACTION_SEVERITY_PRIORITY.indexOf(hint.severity) * 100 + (keyPriority[hint.key] ?? 50);
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

function compactSidecarCommand(command: string): string {
  return clean(command).replace(/^agmo team /, "");
}

function formatSidecarActionLine(action: TeamHudSuggestedAction, teamName: string): string {
  const safeCommand = resolveActionCommand(action, "focused", teamName);
  const command = safeCommand ?? resolveActionCommand(action, "full", teamName);
  const commandHint = command
    ? `${command.mutating ? "manual" : "cmd"}=${compactSidecarCommand(command.command)}`
    : `next=${clean(action.label)}`;
  return `${clean(action.key)}:${action.severity} ${commandHint} (${clean(action.reason)})`;
}

function isUnavailablePane(health: unknown): boolean {
  return health === "missing" || health === "orphaned" || health === "unknown";
}

function pushUniqueHighlight(highlights: TeamHudHighlight[], highlight: TeamHudHighlight): void {
  if (
    highlights.some(
      (entry) =>
        entry.severity === highlight.severity &&
        entry.target === highlight.target &&
        entry.message === highlight.message
    )
  ) {
    return;
  }
  highlights.push(highlight);
}

function inspectHintIdentity(hint: TeamHudInspectHint): string {
  const metadata = Object.entries(hint.metadata)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return `${hint.command}|${metadata}`;
}

function pushUniqueInspectHint(hints: TeamHudInspectHint[], hint: TeamHudInspectHint): void {
  const identity = inspectHintIdentity(hint);
  if (hints.some((entry) => inspectHintIdentity(entry) === identity)) {
    return;
  }
  hints.push(hint);
}

function resolveSidecarHighlights(context: TeamHudRenderContext): TeamHudHighlight[] {
  const highlights: TeamHudHighlight[] = [];
  const { snapshot } = context;

  if (snapshot.leader && isUnavailablePane(snapshot.leader.health)) {
    pushUniqueHighlight(highlights, {
      severity: "critical",
      target: "leader-pane",
      message: snapshot.leader.reasons[0] ?? `leader pane is ${snapshot.leader.health}`
    });
  }
  if (snapshot.hud && isUnavailablePane(snapshot.hud.health)) {
    pushUniqueHighlight(highlights, {
      severity: "critical",
      target: "hud-pane",
      message: snapshot.hud.reasons[0] ?? `HUD pane is ${snapshot.hud.health}`
    });
  }
  if (snapshot.layout_health === "repairable" || snapshot.tmux_health?.layout === "repairable") {
    pushUniqueHighlight(highlights, {
      severity: "critical",
      target: "layout",
      message: "tmux layout is repairable"
    });
  } else if (snapshot.layout_health === "degraded" || snapshot.tmux_health?.layout === "degraded") {
    pushUniqueHighlight(highlights, {
      severity: "warning",
      target: "layout",
      message: "tmux layout is degraded"
    });
  }

  for (const worker of snapshot.workers) {
    if (worker.health === "dead" || worker.health === "stale") {
      pushUniqueHighlight(highlights, {
        severity: worker.health === "dead" ? "critical" : "warning",
        target: worker.worker_name,
        message: worker.reasons[0] ?? `heartbeat ${formatDurationMs(worker.ms_since_heartbeat)} ago`
      });
    }
    if (worker.status_state === "blocked") {
      pushUniqueHighlight(highlights, {
        severity: "warning",
        target: worker.worker_name,
        message: "worker is blocked"
      });
    }
    if (worker.claim_at_risk) {
      pushUniqueHighlight(highlights, {
        severity: "critical",
        target: worker.worker_name,
        message: "task claim is at risk"
      });
    }
  }

  for (const task of context.status.tasks) {
    if (task.status === "failed") {
      pushUniqueHighlight(highlights, {
        severity: "critical",
        target: `task ${task.id}`,
        message: task.error ?? task.subject
      });
    }
    if (task.status === "blocked") {
      pushUniqueHighlight(highlights, {
        severity: "warning",
        target: `task ${task.id}`,
        message: task.subject
      });
    }
  }

  return highlights.sort((left, right) => highlightPriority(left) - highlightPriority(right));
}

function resolveSidecarInspectHints(context: TeamHudRenderContext): TeamHudInspectHint[] {
  const hints: TeamHudInspectHint[] = [];
  const { snapshot } = context;
  const statusCommand = `status ${context.teamName}`;
  const layoutCommand = `layout status ${context.teamName}`;

  if (snapshot.leader && isUnavailablePane(snapshot.leader.health)) {
    pushUniqueInspectHint(hints, {
      severity: "critical",
      key: "leader-pane",
      command: layoutCommand,
      metadata: {},
      reason: "leader-pane"
    });
  }
  if (snapshot.hud && isUnavailablePane(snapshot.hud.health)) {
    pushUniqueInspectHint(hints, {
      severity: "critical",
      key: "hud-pane",
      command: layoutCommand,
      metadata: {},
      reason: "hud-pane"
    });
  }
  if (snapshot.layout_health === "repairable" || snapshot.tmux_health?.layout === "repairable") {
    pushUniqueInspectHint(hints, {
      severity: "critical",
      key: "layout-repairable",
      command: layoutCommand,
      metadata: {},
      reason: "layout"
    });
  } else if (snapshot.layout_health === "degraded" || snapshot.tmux_health?.layout === "degraded") {
    pushUniqueInspectHint(hints, {
      severity: "warning",
      key: "layout-degraded",
      command: layoutCommand,
      metadata: {},
      reason: "layout"
    });
  }
  const worktrees = snapshot.worktree_diagnostics;
  if (
    worktrees &&
    (worktrees.dirty > 0 || worktrees.manual > 0 || worktrees.inspect > 0)
  ) {
    pushUniqueInspectHint(hints, {
      severity: worktrees.manual > 0 || worktrees.dirty > 0 ? "warning" : "info",
      key: "worktree-diagnostics",
      command: `worktree inspect ${context.teamName}`,
      metadata: {
        dirty: String(worktrees.dirty),
        manual: String(worktrees.manual),
        cleanup: String(worktrees.cleanup)
      },
      reason: "worktrees"
    });
  }

  for (const worker of snapshot.workers) {
    const baseMetadata = {
      worker: worker.worker_name,
      ...(worker.current_task_id ? { task: worker.current_task_id } : {})
    };
    if (worker.health === "dead" || worker.health === "stale") {
      pushUniqueInspectHint(hints, {
        severity: worker.health === "dead" ? "critical" : "warning",
        key: `worker-${worker.health}`,
        command: statusCommand,
        metadata: baseMetadata,
        reason: worker.health
      });
    }
    if (worker.status_state === "blocked") {
      pushUniqueInspectHint(hints, {
        severity: "warning",
        key: "worker-blocked",
        command: statusCommand,
        metadata: baseMetadata,
        reason: "blocked"
      });
    }
    if (worker.claim_at_risk) {
      pushUniqueInspectHint(hints, {
        severity: "critical",
        key: "claim-risk",
        command: statusCommand,
        metadata: baseMetadata,
        reason: "claim-risk"
      });
    }
  }

  for (const task of context.status.tasks) {
    if (task.status === "failed" || task.status === "blocked") {
      pushUniqueInspectHint(hints, {
        severity: task.status === "failed" ? "critical" : "warning",
        key: `task-${task.status}`,
        command: statusCommand,
        metadata: {
          task: task.id,
          ...(task.owner ? { worker: task.owner } : {})
        },
        reason: task.status
      });
    }
  }

  return hints.sort((left, right) => inspectHintPriority(left) - inspectHintPriority(right));
}

function formatSidecarHighlightLine(context: TeamHudRenderContext): string | null {
  const highlights = resolveSidecarHighlights(context);
  if (highlights.length === 0) {
    return null;
  }
  const entries = highlights.slice(0, 3).map((highlight) => {
    const marker = highlight.severity === "critical" ? "!!" : highlight.severity === "warning" ? "!" : ".";
    return `${marker} ${clean(highlight.target)}:${clean(highlight.message)}`;
  });
  const more = highlights.length > entries.length ? ` +${highlights.length - entries.length}` : "";
  return `highlights ${entries.join(" | ")}${more}`;
}

function formatSidecarInspectLine(context: TeamHudRenderContext): string | null {
  const hints = resolveSidecarInspectHints(context);
  if (hints.length === 0) {
    return null;
  }

  const entries = hints.slice(0, 3).map((hint) => {
    const metadata = Object.entries(hint.metadata)
      .map(([key, value]) => `${clean(key)}=${clean(value)}`)
      .join(" ");
    const metadataSuffix = metadata ? ` ${metadata}` : "";
    return `${clean(hint.command)}${metadataSuffix} reason=${clean(hint.reason)}`;
  });
  const more = hints.length > entries.length ? ` +${hints.length - entries.length}` : "";
  return `inspect=${entries.join(" | ")}${more}`;
}

function formatSidecarWorktreeLine(context: TeamHudRenderContext): string | null {
  const diagnostics = context.snapshot.worktree_diagnostics;
  if (
    !diagnostics ||
    (diagnostics.dirty === 0 &&
      diagnostics.manual === 0 &&
      diagnostics.cleanup === 0 &&
      diagnostics.inspect === 0)
  ) {
    return null;
  }
  const parts = [
    diagnostics.dirty > 0 ? `dirty=${diagnostics.dirty}` : null,
    diagnostics.manual > 0 ? `manual=${diagnostics.manual}` : null,
    diagnostics.cleanup > 0 ? `cleanup=${diagnostics.cleanup}` : null,
    diagnostics.inspect > 0 ? `inspect=${diagnostics.inspect}` : null,
    diagnostics.missing > 0 ? `missing=${diagnostics.missing}` : null
  ].filter((part): part is string => part !== null);
  return `worktrees ${parts.join(" ")} | inspect=worktree inspect ${clean(context.teamName)}`;
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

function compactWorkerRole(role: string): string {
  return clean(role.replace(/^agmo-/, ""));
}

function resolveWorkerPaneHealth(
  context: TeamHudRenderContext,
  workerName: string
): string | undefined {
  const workerPane = context.snapshot.worker_panes?.find((pane) => pane.worker_name === workerName);
  return workerPane?.health ?? context.snapshot.tmux_health?.workers[workerName];
}

function findWorkerSnapshot(
  context: TeamHudRenderContext,
  workerName: string
): TeamHudWorkerSnapshot | undefined {
  return context.snapshot.workers.find((worker) => worker.worker_name === workerName);
}

function shouldShowPaneHealth(paneHealth: string | undefined, preset: AgmoTeamHudPreset): boolean {
  if (!paneHealth || paneHealth === "not_configured") {
    return false;
  }
  return preset === "full" || paneHealth !== "live";
}

function formatWorkerDiagnosticLine(
  context: TeamHudRenderContext,
  worker: TeamHudWorkerSnapshot,
  preset: AgmoTeamHudPreset,
  c: TeamHudColorize
): string {
  const load = context.openLoads[worker.worker_name] ?? 0;
  const healthTone =
    worker.health === "healthy" ? "green" : worker.health === "stale" ? "yellow" : "red";
  const currentTask = worker.current_task_id ? ` t=${clean(worker.current_task_id)}` : "";
  const dispatch = worker.pending_dispatch_count > 0 ? ` d=${worker.pending_dispatch_count}` : "";
  const risk = worker.claim_at_risk ? " !" : "";
  const paneHealth = resolveWorkerPaneHealth(context, worker.worker_name);
  const pane = shouldShowPaneHealth(paneHealth, preset) ? ` pane=${clean(paneHealth)}` : "";
  const reason =
    (preset === "full" || worker.health !== "healthy" || worker.status_state === "blocked") &&
    worker.reasons[0]
      ? ` reason=${clean(worker.reasons[0])}`
      : "";
  return `${clean(worker.worker_name).padEnd(8)} ${c(worker.health.padEnd(7), healthTone)} ${clean(worker.status_state).padEnd(7)} role=${compactWorkerRole(worker.role)} open=${String(load).padEnd(2)} mail=${worker.mailbox_message_count} hb=${formatDurationMs(worker.ms_since_heartbeat).padEnd(6)}${currentTask}${dispatch}${pane}${reason}${risk}`;
}

function formatTaskOwnerLabel(context: TeamHudRenderContext, owner: string | undefined): string {
  if (!owner) {
    return "unassigned";
  }
  const health = findWorkerSnapshot(context, owner)?.health;
  return health ? `${clean(owner)}/${clean(health)}` : clean(owner);
}

function formatTaskClaimAge(context: TeamHudRenderContext, task: TeamHudTaskSnapshot): string | null {
  if (!task.claim?.claimed_at) {
    return null;
  }
  const claimedAtMs = Date.parse(task.claim.claimed_at);
  const checkedAtMs = Date.parse(context.snapshot.checked_at);
  if (!Number.isFinite(claimedAtMs) || !Number.isFinite(checkedAtMs) || checkedAtMs < claimedAtMs) {
    return null;
  }
  return formatDurationMs(checkedAtMs - claimedAtMs);
}

function formatSidecarTopologyLine(context: TeamHudRenderContext): string | null {
  const workers = [...context.snapshot.workers].sort((left, right) =>
    left.worker_name.localeCompare(right.worker_name, undefined, { numeric: true })
  );
  if (workers.length <= 1) {
    return null;
  }

  const entries = workers.slice(0, 4).map((worker) => {
    const task = worker.current_task_id ? ` t=${clean(worker.current_task_id)}` : "";
    const paneHealth = resolveWorkerPaneHealth(context, worker.worker_name);
    const pane =
      paneHealth && paneHealth !== "live" && paneHealth !== "not_configured"
        ? ` pane=${clean(paneHealth)}`
        : "";
    return `leader->${clean(worker.worker_name)}(${compactWorkerRole(worker.role)}):${clean(worker.status_state)}${task}${pane}`;
  });
  const more = workers.length > entries.length ? ` +${workers.length - entries.length}` : "";
  return `topology ${entries.join(" ; ")}${more}`;
}

function formatEventAge(event: TeamHudRecentEvent, checkedAt: string): string | null {
  if (!event.createdAt) {
    return null;
  }
  const eventMs = Date.parse(event.createdAt);
  const checkedMs = Date.parse(checkedAt);
  if (!Number.isFinite(eventMs) || !Number.isFinite(checkedMs) || checkedMs < eventMs) {
    return null;
  }
  return `${formatDurationMs(checkedMs - eventMs)} ago`;
}

function formatSidecarEventToken(
  event: TeamHudRecentEvent,
  context: TeamHudRenderContext,
  includeAge: boolean
): string {
  const worker = event.worker ? clean(event.worker) : "leader";
  const eventType =
    event.sourceType && event.sourceType !== event.type
      ? `${clean(event.type)}/${clean(event.sourceType)}`
      : clean(event.type);
  const state = event.state ? ` state=${clean(event.state)}` : "";
  const task = event.taskId ? ` t=${clean(event.taskId)}` : "";
  const reason = event.reason ? ` ${clean(event.reason)}` : "";
  const age = includeAge ? formatEventAge(event, context.snapshot.checked_at) : null;
  return `${worker}:${eventType}${state}${task}${reason}${age ? ` ${age}` : ""}`;
}

function formatSidecarEventsLine(context: TeamHudRenderContext): string | null {
  const events = context.recentEvents ?? [];
  if (events.length === 0) {
    return null;
  }

  const entries = events
    .slice(0, 3)
    .map((event) => formatSidecarEventToken(event, context, true));
  const more = events.length > entries.length ? ` +${events.length - entries.length}` : "";
  return `events ${entries.join(" | ")}${more}`;
}

function formatSidecarLastEvent(context: TeamHudRenderContext): string | null {
  const latest = context.recentEvents?.[0];
  return latest ? `last ${formatSidecarEventToken(latest, context, false)}` : null;
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
  const latestEvent = formatSidecarLastEvent(context);
  return `task ${clean(task.id)}:${clean(task.status)} owner=${owner} ${clean(task.subject)}${latestEvent ? ` | ${latestEvent}` : ""}`;
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
    const sidecarMaxLines = options.maxLines ?? 6;
    const sidecarLines = [
      `${c("AGMO sidecar", "bold")} team=${clean(context.teamName)} checked=${clean(snapshot.checked_at)}`,
      `health workers h/s/d=${snapshot.healthy_workers}/${snapshot.stale_workers}/${snapshot.dead_workers} active=${snapshot.active_workers} | tasks p/w/b/c/f=${taskCounts.pending}/${taskCounts.in_progress}/${taskCounts.blocked}/${taskCounts.completed}/${taskCounts.failed}`,
      `tmux leader=${snapshot.leader?.health ?? "n/a"} hud=${snapshot.hud?.health ?? "n/a"} layout=${layoutHealth}${retryCounts} | dispatch=${context.pendingDispatch} | delta=${context.openLoadDelta}`,
      formatSidecarWorkerStrip(context)
    ];
    const highlightSummary = formatSidecarHighlightLine(context);
    if (highlightSummary) {
      sidecarLines.push(ellipsize(highlightSummary, width, false));
    }
    const pushSidecarLine = (line: string): void => {
      if (sidecarLines.length < sidecarMaxLines) {
        sidecarLines.push(ellipsize(line, width, false));
      }
    };
    const inspectSummary = formatSidecarInspectLine(context);
    if (inspectSummary) {
      pushSidecarLine(inspectSummary);
    }
    const topologySummary = formatSidecarTopologyLine(context);
    const eventSummary = formatSidecarEventsLine(context);
    const taskSignal = formatSidecarTaskSignal(context);
    const worktreeSummary = formatSidecarWorktreeLine(context);
    const actionLineCount = suggestedActions.length > 0 ? 1 : 0;
    const taskLineCount = taskSignal ? 1 : 0;
    const reserveTaskSignal = !inspectSummary || !eventSummary;
    const reservedLineCount = actionLineCount + (reserveTaskSignal ? taskLineCount : 0);
    const actionSummary =
      suggestedActions.length > 0
        ? suggestedActions
            .slice(0, 3)
            .map((action) => formatSidecarActionLine(action, context.teamName))
            .join(" | ")
        : null;
    if (
      topologySummary &&
      sidecarMaxLines > 6 &&
      sidecarLines.length + reservedLineCount < sidecarMaxLines
    ) {
      pushSidecarLine(topologySummary);
    }
    if (
      eventSummary &&
      sidecarMaxLines > 6 &&
      sidecarLines.length + reservedLineCount < sidecarMaxLines
    ) {
      pushSidecarLine(eventSummary);
    }
    if (actionSummary && inspectSummary) {
      pushSidecarLine(`${c("actions", "cyan")} ${actionSummary}`);
    }
    if (taskSignal) {
      pushSidecarLine(taskSignal);
    }
    if (worktreeSummary) {
      pushSidecarLine(worktreeSummary);
    }
    if (actionSummary && !inspectSummary) {
      pushSidecarLine(`${c("actions", "cyan")} ${actionSummary}`);
    }
    return `${fitLines(sidecarLines, width, sidecarMaxLines).join("\n")}\n`;
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
      lines.push(formatWorkerDiagnosticLine(context, worker, preset, c));
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
        const claimAge = formatTaskClaimAge(context, task);
        const claimAgeLabel = claimAge ? ` | claim_age=${claimAge}` : "";
        lines.push(
          `task ${clean(task.id)} | ${clean(task.status)} | owner=${formatTaskOwnerLabel(context, task.owner)}${claimAgeLabel} | ${clean(task.subject)}`
        );
      }
    }
  }

  return `${fitLines(lines, width, options.maxLines).join("\n")}\n`;
}
