import type { AgmoTeamStatusSnapshot } from "./state/index.js";
import type { AgmoTeamMonitorSnapshot } from "./state/monitor.js";
import {
  colorize,
  fitLines,
  resolveColorEnabled,
  sanitizeTerminalText,
  type AgmoColorMode
} from "./terminal-format.js";

export type AgmoTeamHudPreset = "minimal" | "focused" | "full";

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
};

export type TeamHudRenderOptions = {
  preset?: AgmoTeamHudPreset;
  maxWidth?: number;
  maxLines?: number;
  color?: AgmoColorMode;
};

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
    topActions: [...values.topActions]
  };
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
  const actions = context.topActions.length > 0 ? context.topActions.join(",") : "none";
  const lines: string[] = [
    `${c("AGMO HUD", "bold")} | team=${clean(context.teamName)} | checked=${clean(snapshot.checked_at)}`,
    `workers h=${snapshot.healthy_workers} s=${snapshot.stale_workers} d=${snapshot.dead_workers} active=${snapshot.active_workers} | tasks p=${taskCounts.pending} w=${taskCounts.in_progress} b=${taskCounts.blocked} c=${taskCounts.completed} f=${taskCounts.failed}`,
    `tmux leader=${snapshot.leader?.health ?? "n/a"} hud=${snapshot.hud?.health ?? "n/a"} | dispatch_pending=${context.pendingDispatch} | open_load_delta=${context.openLoadDelta} | actions=${actions}`
  ];

  if (preset === "minimal") {
    return `${fitLines(lines, width, options.maxLines).join("\n")}\n`;
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
