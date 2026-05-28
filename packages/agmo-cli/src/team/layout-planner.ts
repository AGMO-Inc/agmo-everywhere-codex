export type TeamLayoutPreset = "auto" | "main-vertical" | "tiled";

export type TeamLayoutChoice =
  | "leader-left-stack-right"
  | "leader-left-grid-right"
  | "tiled"
  | "compact-no-hud";

export type TeamLayoutCapacityMetrics = {
  windowArea: number | null;
  usableHeight: number | null;
  reservedHudHeight: number;
  availableWorkerWidth: number | null;
  availableWorkerHeight: number | null;
  workerCellWidth: number | null;
  workerCellHeight: number | null;
  workerCellArea: number | null;
  requestedWorkers: number;
  visibleWorkerCapacity: number | null;
  overflowWorkers: number;
  leaderMeetsMinimum: boolean | null;
  workersMeetMinimumWidth: boolean | null;
  workersMeetMinimumHeight: boolean | null;
  hudFits: boolean | null;
  hudDisabled: boolean;
};

export type TeamLayoutStrategyEvaluation = {
  choice: TeamLayoutChoice;
  columns: number;
  rows: number;
  leaderWidth: number | null;
  hudHeight: number;
  metrics: TeamLayoutCapacityMetrics;
  score: number;
  reasons: string[];
};

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
  selectedReason: string;
  metrics: TeamLayoutCapacityMetrics;
  evaluatedStrategies?: TeamLayoutStrategyEvaluation[];
  warnings: string[];
};

function unknownMetrics(workerCount: number, hudHeight: number, hudDisabled = false): TeamLayoutCapacityMetrics {
  return {
    windowArea: null,
    usableHeight: null,
    reservedHudHeight: hudHeight,
    availableWorkerWidth: null,
    availableWorkerHeight: null,
    workerCellWidth: null,
    workerCellHeight: null,
    workerCellArea: null,
    requestedWorkers: workerCount,
    visibleWorkerCapacity: null,
    overflowWorkers: workerCount,
    leaderMeetsMinimum: null,
    workersMeetMinimumWidth: null,
    workersMeetMinimumHeight: null,
    hudFits: null,
    hudDisabled
  };
}

function uniqueWarnings(warnings: string[]): string[] {
  return Array.from(new Set(warnings));
}

function evaluateStrategy(
  choice: TeamLayoutChoice,
  args: {
    width: number;
    height: number;
    workerCount: number;
    requestedHudHeight: number;
    hudHeight: number;
    minWorkerWidth: number;
    minWorkerHeight: number;
    minLeaderWidth: number;
  }
): TeamLayoutStrategyEvaluation {
  const leaderWidth = choice === "tiled" ? null : Math.max(args.minLeaderWidth, Math.floor(args.width * 0.45));
  const availableWorkerWidth = Math.max(0, args.width - (leaderWidth ?? 0));
  const usableHeight = Math.max(0, args.height - args.hudHeight);
  const widthCapacity = Math.floor(availableWorkerWidth / args.minWorkerWidth);
  const heightCapacity = Math.floor(usableHeight / args.minWorkerHeight);
  const maxColumns = Math.max(1, Math.min(args.workerCount || 1, widthCapacity || 1));
  const columns =
    args.workerCount <= 0
      ? 0
      : choice === "leader-left-stack-right" || choice === "compact-no-hud"
        ? 1
        : maxColumns;
  const rows = args.workerCount <= 0 ? 0 : Math.max(1, Math.ceil(args.workerCount / Math.max(columns, 1)));
  const workerCellWidth = args.workerCount <= 0 ? availableWorkerWidth : Math.floor(availableWorkerWidth / Math.max(columns, 1));
  const workerCellHeight = args.workerCount <= 0 ? usableHeight : Math.floor(usableHeight / Math.max(rows, 1));
  const leaderMeetsMinimum = leaderWidth === null ? null : leaderWidth >= args.minLeaderWidth;
  const workersMeetMinimumWidth = args.workerCount <= 0 || workerCellWidth >= args.minWorkerWidth;
  const workersMeetMinimumHeight = args.workerCount <= 0 || workerCellHeight >= args.minWorkerHeight;
  const rawCapacity =
    args.workerCount <= 0
      ? 0
      : workersMeetMinimumWidth
        ? choice === "leader-left-stack-right" || choice === "compact-no-hud"
          ? heightCapacity
          : Math.max(0, columns) * heightCapacity
        : 0;
  const visibleWorkerCapacity = Math.min(args.workerCount, Math.max(0, rawCapacity));
  const overflowWorkers = Math.max(0, args.workerCount - visibleWorkerCapacity);
  const hudDisabled = args.requestedHudHeight > 0 && args.hudHeight === 0;
  const metrics: TeamLayoutCapacityMetrics = {
    windowArea: args.width * args.height,
    usableHeight,
    reservedHudHeight: args.hudHeight,
    availableWorkerWidth,
    availableWorkerHeight: usableHeight,
    workerCellWidth,
    workerCellHeight,
    workerCellArea: workerCellWidth * workerCellHeight,
    requestedWorkers: args.workerCount,
    visibleWorkerCapacity,
    overflowWorkers,
    leaderMeetsMinimum,
    workersMeetMinimumWidth,
    workersMeetMinimumHeight,
    hudFits: args.requestedHudHeight === 0 ? true : args.height >= args.minWorkerHeight + args.requestedHudHeight + 4,
    hudDisabled
  };
  const reasons: string[] = [];
  let score = visibleWorkerCapacity * 100;
  if (overflowWorkers === 0) score += 1_000;
  if (workersMeetMinimumWidth) score += 100;
  if (workersMeetMinimumHeight) score += 100;
  if (leaderMeetsMinimum === true) score += 80;
  if (choice === "leader-left-stack-right" && args.workerCount <= 3 && overflowWorkers === 0) score += 80;
  if (choice === "leader-left-grid-right" && args.workerCount >= 4 && overflowWorkers === 0) score += 70;
  if (choice === "compact-no-hud" && hudDisabled && overflowWorkers === 0) score += 60;
  if (choice === "tiled" && overflowWorkers === 0) score += 30;
  if (hudDisabled && choice !== "compact-no-hud") score -= 100;
  if (overflowWorkers > 0) reasons.push("layout_capacity_overflow");
  if (leaderMeetsMinimum === false) reasons.push("leader_pane_below_minimum_width");
  if (!workersMeetMinimumWidth) reasons.push("worker_panes_below_minimum_width");
  if (!workersMeetMinimumHeight) reasons.push("worker_panes_below_minimum_height");
  if (hudDisabled) reasons.push("hud_disabled_for_compact_capacity");
  return {
    choice,
    columns,
    rows,
    leaderWidth,
    hudHeight: args.hudHeight,
    metrics,
    score,
    reasons
  };
}

function selectedReasonFor(candidate: TeamLayoutStrategyEvaluation, workerCount: number): string {
  if (workerCount <= 0) return "no_workers";
  if (candidate.choice === "compact-no-hud") return "compact_window_drops_hud";
  if (candidate.choice === "tiled") return "tiled_best_capacity";
  if (candidate.choice === "leader-left-grid-right") return "grid_preserves_worker_capacity";
  return "small_team_stack_fits";
}

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
  const requestedHudHeight = options.hud === false ? 0 : 6;
  const normalizedWorkerCount = Math.max(0, Math.floor(workerCount));

  if (normalizedWorkerCount <= 0) {
    const metrics = width === null || height === null
      ? unknownMetrics(0, requestedHudHeight)
      : evaluateStrategy("leader-left-stack-right", {
          width,
          height,
          workerCount: 0,
          requestedHudHeight,
          hudHeight: requestedHudHeight,
          minWorkerWidth,
          minWorkerHeight,
          minLeaderWidth
        }).metrics;
    return {
      preset,
      choice: "leader-left-stack-right",
      health: "ok",
      workerCount: normalizedWorkerCount,
      windowWidth: width,
      windowHeight: height,
      leaderWidth: width,
      hudHeight: requestedHudHeight,
      columns: 0,
      rows: 0,
      selectedReason: "no_workers",
      metrics,
      warnings: []
    };
  }

  if (width === null || height === null) {
    const choice = preset === "tiled" ? "tiled" : "leader-left-stack-right";
    return {
      preset,
      choice,
      health: "degraded",
      workerCount: normalizedWorkerCount,
      windowWidth: width,
      windowHeight: height,
      leaderWidth: null,
      hudHeight: requestedHudHeight,
      columns: 1,
      rows: normalizedWorkerCount,
      selectedReason: preset === "tiled" ? "explicit_tiled_preset" : "geometry_unavailable_fallback",
      metrics: unknownMetrics(normalizedWorkerCount, requestedHudHeight),
      warnings: ["tmux_geometry_unavailable"]
    };
  }

  const choices: TeamLayoutChoice[] = [
    "leader-left-stack-right",
    "leader-left-grid-right",
    "tiled",
    "compact-no-hud"
  ];
  const evaluatedStrategies = choices.map((choice) =>
    evaluateStrategy(choice, {
      width,
      height,
      workerCount: normalizedWorkerCount,
      requestedHudHeight,
      hudHeight: choice === "compact-no-hud" ? 0 : requestedHudHeight,
      minWorkerWidth,
      minWorkerHeight,
      minLeaderWidth
    })
  );
  const byChoice = new Map(evaluatedStrategies.map((candidate) => [candidate.choice, candidate]));
  const stack = byChoice.get("leader-left-stack-right")!;
  const grid = byChoice.get("leader-left-grid-right")!;
  const tiled = byChoice.get("tiled")!;
  const compact = byChoice.get("compact-no-hud")!;

  let selected: TeamLayoutStrategyEvaluation;
  let selectedReason: string;
  if (preset === "tiled") {
    selected = tiled;
    selectedReason = "explicit_tiled_preset";
  } else if (preset === "main-vertical") {
    selected = stack;
    selectedReason = "explicit_main_vertical_preset";
  } else if (normalizedWorkerCount <= 3 && stack.metrics.overflowWorkers === 0) {
    selected = stack;
    selectedReason = "small_team_stack_fits";
  } else if (normalizedWorkerCount >= 4 && grid.metrics.overflowWorkers === 0) {
    selected = grid;
    selectedReason = "grid_preserves_worker_capacity";
  } else if (
    requestedHudHeight > 0 &&
    compact.metrics.overflowWorkers < stack.metrics.overflowWorkers
  ) {
    selected = compact;
    selectedReason = "compact_window_drops_hud";
  } else {
    selected = [...evaluatedStrategies].sort((left, right) => right.score - left.score)[0] ?? stack;
    selectedReason = selectedReasonFor(selected, normalizedWorkerCount);
  }

  const warnings = uniqueWarnings([
    ...(selected.choice !== "tiled" && width < minLeaderWidth + minWorkerWidth
      ? ["window_too_narrow_for_leader_and_worker_minimums"]
      : []),
    ...(requestedHudHeight > 0 && height < minWorkerHeight + requestedHudHeight + 4
      ? ["hud_reduces_compact_window_capacity"]
      : []),
    ...selected.reasons
  ]);

  return {
    preset,
    choice: selected.choice,
    health: warnings.length > 0 ? "degraded" : "ok",
    workerCount: normalizedWorkerCount,
    windowWidth: width,
    windowHeight: height,
    leaderWidth: selected.leaderWidth,
    hudHeight: selected.hudHeight,
    columns: selected.columns,
    rows: selected.rows,
    selectedReason,
    metrics: selected.metrics,
    evaluatedStrategies,
    warnings
  };
}
