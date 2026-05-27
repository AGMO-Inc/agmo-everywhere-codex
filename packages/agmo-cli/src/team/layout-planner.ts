export type TeamLayoutPreset = "auto" | "main-vertical" | "tiled";

export type TeamLayoutChoice =
  | "leader-left-stack-right"
  | "leader-left-grid-right"
  | "tiled"
  | "compact-no-hud";

export type TeamLayoutPlan = {
  preset: TeamLayoutPreset;
  choice: TeamLayoutChoice;
  health: "ok" | "degraded";
  workerCount: number;
  windowWidth: number | null;
  windowHeight: number | null;
  leaderWidth: number | null;
  hudHeight: number;
  columns: number;
  rows: number;
  warnings: string[];
};

export function computeTeamLayoutPlan(
  windowWidth: number | null | undefined,
  windowHeight: number | null | undefined,
  workerCount: number,
  options: {
    preset?: TeamLayoutPreset;
    hud?: boolean;
    minWorkerWidth?: number;
    minWorkerHeight?: number;
    minLeaderWidth?: number;
  } = {}
): TeamLayoutPlan {
  const preset = options.preset ?? "auto";
  const width = Number.isFinite(windowWidth ?? NaN) ? Math.max(1, Math.floor(windowWidth ?? 0)) : null;
  const height = Number.isFinite(windowHeight ?? NaN) ? Math.max(1, Math.floor(windowHeight ?? 0)) : null;
  const minWorkerWidth = options.minWorkerWidth ?? 32;
  const minWorkerHeight = options.minWorkerHeight ?? 8;
  const minLeaderWidth = options.minLeaderWidth ?? 48;
  const hudHeight = options.hud === false ? 0 : 6;
  const warnings: string[] = [];

  if (workerCount <= 0) {
    return {
      preset,
      choice: "leader-left-stack-right",
      health: "ok",
      workerCount,
      windowWidth: width,
      windowHeight: height,
      leaderWidth: width,
      hudHeight,
      columns: 0,
      rows: 0,
      warnings
    };
  }

  if (width === null || height === null) {
    return {
      preset,
      choice: preset === "tiled" ? "tiled" : "leader-left-stack-right",
      health: "degraded",
      workerCount,
      windowWidth: width,
      windowHeight: height,
      leaderWidth: null,
      hudHeight,
      columns: 1,
      rows: workerCount,
      warnings: ["tmux_geometry_unavailable"]
    };
  }

  const usableHeight = Math.max(1, height - hudHeight);
  const rightWidth = Math.max(1, width - minLeaderWidth);
  const maxColumns = Math.max(1, Math.floor(rightWidth / minWorkerWidth));
  const stackHeight = Math.floor(usableHeight / workerCount);
  const needsGrid = workerCount > 3 && maxColumns > 1;
  const forcedTiled = preset === "tiled";
  const columns = forcedTiled
    ? Math.max(1, Math.min(workerCount, Math.floor(width / minWorkerWidth)))
    : needsGrid
      ? Math.min(workerCount, maxColumns)
      : 1;
  const rows = Math.max(1, Math.ceil(workerCount / columns));
  const workerHeight = Math.floor(usableHeight / rows);
  const leaderWidth = forcedTiled ? null : Math.max(minLeaderWidth, Math.floor(width * 0.45));

  if (!forcedTiled && width < minLeaderWidth + minWorkerWidth) {
    warnings.push("window_too_narrow_for_leader_and_worker_minimums");
  }
  if ((columns === 1 ? stackHeight : workerHeight) < minWorkerHeight) {
    warnings.push("worker_panes_below_minimum_height");
  }
  if (hudHeight > 0 && height < minWorkerHeight + hudHeight + 4) {
    warnings.push("hud_reduces_compact_window_capacity");
  }

  const choice: TeamLayoutChoice =
    forcedTiled || preset === "main-vertical"
      ? forcedTiled
        ? "tiled"
        : "leader-left-stack-right"
      : width < minLeaderWidth + minWorkerWidth
        ? "compact-no-hud"
        : needsGrid
          ? "leader-left-grid-right"
          : "leader-left-stack-right";

  return {
    preset,
    choice,
    health: warnings.length > 0 ? "degraded" : "ok",
    workerCount,
    windowWidth: width,
    windowHeight: height,
    leaderWidth,
    hudHeight: choice === "compact-no-hud" ? 0 : hudHeight,
    columns,
    rows,
    warnings
  };
}
