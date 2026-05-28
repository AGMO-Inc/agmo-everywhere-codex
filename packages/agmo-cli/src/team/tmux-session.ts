import { execFileSync } from "node:child_process";
import { ensureCodexCliArgs, normalizeCodexAutonomyMode } from "../utils/codex.js";
import type { AgmoColorMode } from "./terminal-format.js";
import type { AgmoTeamHudPreset } from "./hud-renderer.js";
import {
  computeTeamLayoutPlan,
  type TeamLayoutPreset,
  type TeamLayoutPlan
} from "./layout-planner.js";

const DEFAULT_TMUX_HUD_PRESET: AgmoTeamHudPreset = "sidecar";
const DEFAULT_TMUX_HUD_MAX_LINES = 6;

export type TmuxTopology = {
  available: boolean;
  in_tmux_client: boolean;
  session_id: string | null;
  leader_pane_id: string | null;
  topology: {
    leader: string;
    workers: string;
    hud: string;
  };
};

export type TmuxWorkerPaneSpec = {
  teamName: string;
  workerName: string;
  projectRoot: string;
  workingDir: string;
  inboxPath: string;
  role: string;
  taskSummary: string;
  instructionsPath: string;
};

export type CreatedTmuxSession = {
  sessionId: string | null;
  leaderPaneId: string;
  workerPaneIds: Record<string, string>;
  hudPaneId?: string | null;
  layoutPlan?: TeamLayoutPlan;
};

export type TmuxPaneDestructionResult = {
  pane_id: string;
  status: "killed" | "failed" | "skipped";
  reason?: string;
  error?: string;
};

export type TmuxPaneDestructionSummary = {
  panes: TmuxPaneDestructionResult[];
  killed: number;
  failed: number;
  skipped: number;
};

type TmuxCommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

type TmuxRunner = (args: string[]) => TmuxCommandResult;

export type TmuxPaneInfo = {
  session_id: string;
  session_name: string;
  window_id: string;
  pane_id: string;
  active: boolean;
  dead: boolean;
  command: string;
  start_command?: string;
  title?: string;
  pane_width?: number | null;
  pane_height?: number | null;
  pane_left?: number | null;
  pane_top?: number | null;
  window_width?: number | null;
  window_height?: number | null;
};

export type TmuxCurrentPaneInfo = {
  session_id: string;
  session_name: string;
  window_id: string;
  pane_id: string;
};

export type TmuxPaneCloseGuard = {
  expectedSessionId?: string | null;
  leaderPaneId?: string | null;
  currentPaneId?: string | null;
  protectPaneIds?: string[];
};

export type TmuxHudSpec = {
  teamName: string;
  projectRoot: string;
  cliEntryPath: string;
  refreshMs?: number;
  clearScreen?: boolean;
  leaderPaneId?: string | null;
  sessionId?: string | null;
  ownerTags?: boolean;
  preset?: AgmoTeamHudPreset;
  width?: number;
  maxLines?: number;
  color?: AgmoColorMode;
};

export type TmuxHudOwner = {
  owned: boolean;
  teamName?: string;
  leaderPaneId?: string;
  sessionId?: string;
};

export type TmuxLayoutAction = {
  kind: string;
  target: string;
  reason: string;
};

export type TmuxLayoutOperationResult = {
  status: "completed" | "partial" | "skipped" | "failed" | "refused";
  layoutPlan?: TeamLayoutPlan;
  planned: TmuxLayoutAction[];
  performed: TmuxLayoutAction[];
  skipped: TmuxLayoutAction[];
  failed: Array<TmuxLayoutAction & { error: string }>;
  refused: Array<TmuxLayoutAction & { reason: string }>;
};

export type TmuxHudReapResult = {
  pane_id: string;
  status: "planned" | "killed" | "skipped" | "failed" | "refused";
  reason: string;
  team_name?: string;
  leader_pane_id?: string;
  session_id?: string;
  error?: string;
};

export type TmuxHudReapSummary = {
  planned: TmuxHudReapResult[];
  performed: TmuxHudReapResult[];
  skipped: TmuxHudReapResult[];
  failed: TmuxHudReapResult[];
  refused: TmuxHudReapResult[];
};

function runTmux(args: string[]): TmuxCommandResult {
  try {
    const stdout = execFileSync("tmux", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    const err = error as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };
    const stderr =
      (typeof err.stderr === "string"
        ? err.stderr
        : err.stderr instanceof Buffer
          ? err.stderr.toString("utf-8")
          : "") ||
      (typeof err.stdout === "string"
        ? err.stdout
        : err.stdout instanceof Buffer
          ? err.stdout.toString("utf-8")
          : "") ||
      err.message ||
      "tmux command failed";

    return {
      ok: false,
      stdout: "",
      stderr: stderr.trim()
    };
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildWorkerCodexArgs(prompt: string): string[] {
  return [
    "codex",
    ...ensureCodexCliArgs(
      ["--no-alt-screen", prompt],
      normalizeCodexAutonomyMode(process.env.AGMO_CODEX_AUTONOMY_MODE) ?? "full-auto"
    )
  ];
}

function buildWorkerBootstrapCommand(spec: TmuxWorkerPaneSpec): string {
  const prompt = [
    `You are ${spec.workerName} for team ${spec.teamName}.`,
    `Read the inbox file at ${spec.inboxPath} first.`,
    `Operate in the role ${spec.role}.`,
    `Follow the worker instructions in ${spec.instructionsPath}.`,
    `Current task summary: ${spec.taskSummary}.`
  ].join(" ");
  const args = buildWorkerCodexArgs(prompt);
  const exports = [
    `export AGMO_TEAM_NAME=${shellQuote(spec.teamName)}`,
    `export AGMO_WORKER_NAME=${shellQuote(spec.workerName)}`,
    `export AGMO_PROJECT_ROOT=${shellQuote(spec.projectRoot)}`,
    `export AGMO_WORKER_ROLE=${shellQuote(spec.role)}`,
    "export AGMO_WORKER_PID=$$"
  ].join("; ");

  return `${exports}; exec ${args.map(shellQuote).join(" ")}`;
}

function buildHudCliArgs(spec: TmuxHudSpec): string[] {
  const refreshMs = Math.max(spec.refreshMs ?? 2000, 250);
  const preset = spec.preset ?? DEFAULT_TMUX_HUD_PRESET;
  const maxLines = spec.maxLines ?? DEFAULT_TMUX_HUD_MAX_LINES;
  const args = [
    "team",
    "hud",
    spec.teamName,
    "--watch",
    "--refresh-ms",
    String(refreshMs),
    spec.clearScreen === false ? "--no-clear" : "--clear"
  ];
  args.push("--preset", preset);
  if (typeof spec.width === "number") {
    args.push("--width", String(spec.width));
  }
  args.push("--max-lines", String(maxLines));
  if (spec.color === "always") {
    args.push("--color");
  } else if (spec.color === "never") {
    args.push("--no-color");
  }
  return args;
}

export function buildHudCommand(spec: TmuxHudSpec): string {
  const envExports =
    spec.ownerTags === false
      ? []
      : [
          `export AGMO_TEAM_NAME=${shellQuote(spec.teamName)}`,
          "export AGMO_TMUX_HUD_OWNER=1",
          ...(spec.leaderPaneId ? [`export AGMO_TMUX_HUD_LEADER_PANE=${shellQuote(spec.leaderPaneId)}`] : []),
          ...(spec.sessionId ? [`export AGMO_TMUX_SESSION_ID=${shellQuote(spec.sessionId)}`] : [])
        ];
  const hudCmd = [
    `cd ${shellQuote(spec.projectRoot)}`,
    ...envExports,
    `exec node ${shellQuote(spec.cliEntryPath)} ${buildHudCliArgs(spec).map(shellQuote).join(" ")}`
  ].join("; ");
  return `exec zsh -lc ${shellQuote(hudCmd)}`;
}

export function isTmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function currentTmuxPaneId(): string | null {
  const pane = process.env.TMUX_PANE?.trim();
  return pane ? pane : null;
}

function parseTmuxBoolean(value: string | undefined): boolean {
  return value === "1";
}

function parseTmuxNumber(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function listTmuxPanes(runner: TmuxRunner = runTmux): TmuxPaneInfo[] {
  const result = runner([
    "list-panes",
    "-a",
    "-F",
    "#{session_id}\t#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_active}\t#{pane_dead}\t#{pane_current_command}\t#{pane_start_command}\t#{pane_title}\t#{pane_width}\t#{pane_height}\t#{pane_left}\t#{pane_top}\t#{window_width}\t#{window_height}"
  ]);
  if (!result.ok || !result.stdout.trim()) {
    return [];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [
        sessionId,
        sessionName,
        windowId,
        paneId,
        active,
        dead,
        command,
        startCommand,
        title,
        paneWidth,
        paneHeight,
        paneLeft,
        paneTop,
        windowWidth,
        windowHeight
      ] = line.split("\t");
      if (!sessionId || !windowId || !paneId) {
        return [];
      }
      return [
        {
          session_id: sessionId,
          session_name: sessionName ?? "",
          window_id: windowId,
          pane_id: paneId,
          active: parseTmuxBoolean(active),
          dead: parseTmuxBoolean(dead),
          command: command ?? "",
          start_command: startCommand ?? "",
          title: title ?? "",
          pane_width: parseTmuxNumber(paneWidth),
          pane_height: parseTmuxNumber(paneHeight),
          pane_left: parseTmuxNumber(paneLeft),
          pane_top: parseTmuxNumber(paneTop),
          window_width: parseTmuxNumber(windowWidth),
          window_height: parseTmuxNumber(windowHeight)
        }
      ];
    });
}

export function currentTmuxPaneInfo(
  runner: TmuxRunner = runTmux
): TmuxCurrentPaneInfo | null {
  const result = runner([
    "display-message",
    "-p",
    "-F",
    "#{session_id}\t#{session_name}\t#{window_id}\t#{pane_id}"
  ]);
  if (!result.ok || !result.stdout.trim()) {
    return null;
  }
  const [sessionId, sessionName, windowId, paneId] = result.stdout.trim().split("\t");
  if (!sessionId || !windowId || !paneId) {
    return null;
  }
  return {
    session_id: sessionId,
    session_name: sessionName ?? "",
    window_id: windowId,
    pane_id: paneId
  };
}

function parseExportedValue(command: string, name: string): string | undefined {
  const patterns = [
    new RegExp(`(?:^|[;\\s])export\\s+${name}='([^']*)'`),
    new RegExp(`(?:^|[;\\s])export\\s+${name}=([^;\\s]+)`)
  ];
  for (const pattern of patterns) {
    const match = command.match(pattern);
    if (match?.[1]) {
      return match[1].replace(/'\\''/g, "'");
    }
  }
  return undefined;
}

export function readAgmoHudPaneOwner(pane: Pick<TmuxPaneInfo, "start_command" | "title">): TmuxHudOwner {
  const command = pane.start_command ?? "";
  const title = pane.title ?? "";
  const titleTeam = title.startsWith("agmo:hud:") ? title.slice("agmo:hud:".length) : undefined;
  const envOwned = parseExportedValue(command, "AGMO_TMUX_HUD_OWNER") === "1";
  const teamName = parseExportedValue(command, "AGMO_TEAM_NAME") ?? titleTeam;
  const leaderPaneId = parseExportedValue(command, "AGMO_TMUX_HUD_LEADER_PANE");
  const sessionId = parseExportedValue(command, "AGMO_TMUX_SESSION_ID");
  return {
    owned: Boolean(envOwned || titleTeam),
    ...(teamName ? { teamName } : {}),
    ...(leaderPaneId ? { leaderPaneId } : {}),
    ...(sessionId ? { sessionId } : {})
  };
}

export function isAgmoHudWatchPane(pane: Pick<TmuxPaneInfo, "start_command" | "title">): boolean {
  const owner = readAgmoHudPaneOwner(pane);
  return owner.owned && (pane.start_command ?? "").includes(" team hud ");
}

export function hudPaneMatchesOwner(
  pane: TmuxPaneInfo,
  owner: { teamName: string; leaderPaneId?: string | null; sessionId?: string | null }
): boolean {
  const paneOwner = readAgmoHudPaneOwner(pane);
  return Boolean(
    paneOwner.owned &&
      paneOwner.teamName === owner.teamName &&
      (!owner.leaderPaneId || paneOwner.leaderPaneId === owner.leaderPaneId) &&
      (!owner.sessionId || paneOwner.sessionId === owner.sessionId)
  );
}

export function findHudPaneIds(
  panes: TmuxPaneInfo[],
  owner: { teamName: string; leaderPaneId?: string | null; sessionId?: string | null }
): string[] {
  return panes
    .filter((pane) => !pane.dead && hudPaneMatchesOwner(pane, owner))
    .map((pane) => pane.pane_id);
}

export function reapOrphanHudPanes(
  options: {
    teamName: string;
    sessionId?: string | null;
    leaderPaneId?: string | null;
    protectPaneIds?: string[];
    dryRun?: boolean;
  },
  runner: TmuxRunner = runTmux
): TmuxHudReapSummary {
  const summary: TmuxHudReapSummary = {
    planned: [],
    performed: [],
    skipped: [],
    failed: [],
    refused: []
  };
  const panes = listTmuxPanes(runner);
  const livePaneIds = new Set(panes.filter((pane) => !pane.dead).map((pane) => pane.pane_id));
  const currentPaneId = currentTmuxPaneInfo(runner)?.pane_id ?? currentTmuxPaneId();
  const protectedPaneIds = new Set([
    ...(options.leaderPaneId ? [options.leaderPaneId] : []),
    ...(currentPaneId ? [currentPaneId] : []),
    ...(options.protectPaneIds ?? [])
  ]);

  for (const pane of panes) {
    const owner = readAgmoHudPaneOwner(pane);
    if (!owner.owned || owner.teamName !== options.teamName) {
      continue;
    }

    const base = {
      pane_id: pane.pane_id,
      team_name: owner.teamName,
      ...(owner.leaderPaneId ? { leader_pane_id: owner.leaderPaneId } : {}),
      ...(owner.sessionId ? { session_id: owner.sessionId } : {})
    };

    if (!owner.leaderPaneId) {
      summary.skipped.push({
        ...base,
        status: "skipped",
        reason: "owner_leader_tag_missing"
      });
      continue;
    }
    if (livePaneIds.has(owner.leaderPaneId)) {
      summary.skipped.push({
        ...base,
        status: "skipped",
        reason: "owner_leader_live"
      });
      continue;
    }

    const expectedSessionId = options.sessionId ?? owner.sessionId;
    if (expectedSessionId && pane.session_id !== expectedSessionId) {
      summary.refused.push({
        ...base,
        status: "refused",
        reason: "foreign_session"
      });
      continue;
    }
    if (protectedPaneIds.has(pane.pane_id)) {
      summary.refused.push({
        ...base,
        status: "refused",
        reason: pane.pane_id === currentPaneId ? "current_pane_protected" : "protected_pane"
      });
      continue;
    }

    const planned = {
      ...base,
      status: "planned" as const,
      reason: "owner_leader_missing"
    };
    summary.planned.push(planned);
    if (options.dryRun) {
      continue;
    }

    const result = runner(["kill-pane", "-t", pane.pane_id]);
    if (result.ok) {
      summary.performed.push({
        ...base,
        status: "killed",
        reason: "orphan_owned_hud_reaped"
      });
    } else {
      summary.failed.push({
        ...base,
        status: "failed",
        reason: "orphan_owned_hud_reap_failed",
        error: result.stderr || "tmux kill-pane failed"
      });
    }
  }

  return summary;
}

export function describeTmuxSessionTopology(workerCount: number): TmuxTopology {
  const current = currentTmuxPaneInfo();
  return {
    available: isTmuxAvailable(),
    in_tmux_client: Boolean(current?.pane_id ?? currentTmuxPaneId()),
    session_id: current?.session_id ?? null,
    leader_pane_id: current?.pane_id ?? currentTmuxPaneId(),
    topology: {
      leader: "left/main pane",
      workers: `stacked right panes (${workerCount})`,
      hud: "optional bottom-left refresh pane"
    }
  };
}

export function createTeamSession(
  workerSpecs: TmuxWorkerPaneSpec[],
  options: {
    hud?: TmuxHudSpec;
    runner?: TmuxRunner;
  } = {}
): CreatedTmuxSession {
  const runner = options.runner ?? runTmux;
  const current = currentTmuxPaneInfo(runner);
  const leaderPaneId = current?.pane_id ?? currentTmuxPaneId();
  if (!leaderPaneId) {
    throw new Error("tmux current pane not detected");
  }
  const currentPane = listTmuxPanes(runner).find((pane) => pane.pane_id === leaderPaneId);
  const layoutPlan = computeTeamLayoutPlan(
    currentPane?.window_width,
    currentPane?.window_height,
    workerSpecs.length,
    { hud: Boolean(options.hud) }
  );

  const workerPaneIds: Record<string, string> = {};
  let rightStackRootPaneId: string | null = null;
  runner(["select-pane", "-t", leaderPaneId, "-T", `agmo:leader:${workerSpecs[0]?.teamName ?? "team"}`]);

  for (let index = 0; index < workerSpecs.length; index += 1) {
    const spec = workerSpecs[index];
    const splitDirection =
      layoutPlan.choice === "tiled"
        ? index === 0
          ? "-h"
          : "-v"
        : index === 0
          ? "-h"
          : layoutPlan.choice === "leader-left-grid-right" && index % Math.max(layoutPlan.columns, 1) === 0
            ? "-h"
            : "-v";
    const splitTarget = index === 0 ? leaderPaneId : rightStackRootPaneId ?? leaderPaneId;
    const command = buildWorkerBootstrapCommand(spec);
    const result = runner([
      "split-window",
      splitDirection,
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      splitTarget,
      "-c",
      spec.workingDir,
      command
    ]);

    if (!result.ok) {
      throw new Error(`failed to create tmux pane for ${spec.workerName}: ${result.stderr}`);
    }

    const paneId = result.stdout.split("\n")[0]?.trim();
    if (!paneId || !paneId.startsWith("%")) {
      throw new Error(`invalid pane id for ${spec.workerName}`);
    }

    workerPaneIds[spec.workerName] = paneId;
    runner(["select-pane", "-t", paneId, "-T", `agmo:worker:${spec.teamName}:${spec.workerName}`]);
    if (index === 0) {
      rightStackRootPaneId = paneId;
    }
  }

  let hudPaneId: string | null = null;
  if (options.hud && layoutPlan.hudHeight > 0) {
    hudPaneId = createHudPane(
      {
        ...options.hud,
        leaderPaneId,
        sessionId: current?.session_id ?? options.hud.sessionId,
        ownerTags: options.hud.ownerTags ?? true
      },
      {
        targetPaneId: leaderPaneId,
        runner
      }
    );
  }

  runner(["select-layout", "-t", leaderPaneId, layoutPlan.choice === "tiled" ? "tiled" : "main-vertical"]);
  runner(["select-pane", "-t", leaderPaneId]);

  return {
    sessionId: current?.session_id ?? null,
    leaderPaneId,
    workerPaneIds,
    hudPaneId,
    layoutPlan
  };
}

function evaluatePaneCloseGuard(
  paneId: string,
  paneInfo: TmuxPaneInfo | undefined,
  guard: TmuxPaneCloseGuard
): string | null {
  const protectedPaneIds = new Set([
    ...(guard.protectPaneIds ?? []),
    ...(guard.leaderPaneId ? [guard.leaderPaneId] : []),
    ...(guard.currentPaneId ? [guard.currentPaneId] : [])
  ]);
  if (protectedPaneIds.has(paneId)) {
    return paneId === guard.currentPaneId
      ? "refusing to kill current tmux pane"
      : "refusing to kill protected tmux pane";
  }
  if (!paneInfo) {
    return guard.expectedSessionId !== undefined ? "tmux pane not found" : null;
  }
  if (guard.expectedSessionId && paneInfo.session_id !== guard.expectedSessionId) {
    return `refusing to kill pane from another tmux session (${paneInfo.session_id})`;
  }
  return null;
}

export function destroyWorkerPanes(
  paneIds: string[],
  runner: TmuxRunner = runTmux,
  guard: TmuxPaneCloseGuard = {}
): TmuxPaneDestructionSummary {
  const panes: TmuxPaneDestructionResult[] = [];
  const uniquePaneIds = Array.from(new Set(paneIds));
  const tmuxPanes = listTmuxPanes(runner);
  const paneById = new Map(tmuxPanes.map((pane) => [pane.pane_id, pane]));
  const currentPaneId =
    Object.prototype.hasOwnProperty.call(guard, "currentPaneId")
      ? guard.currentPaneId
      : currentTmuxPaneId();
  const effectiveGuard = {
    ...guard,
    currentPaneId
  };

  for (const paneId of uniquePaneIds) {
    if (!paneId.startsWith("%")) {
      panes.push({
        pane_id: paneId,
        status: "skipped",
        reason: "invalid_tmux_pane_id",
        error: "invalid tmux pane id"
      });
      continue;
    }

    const guardReason = evaluatePaneCloseGuard(paneId, paneById.get(paneId), effectiveGuard);
    if (guardReason) {
      panes.push({
        pane_id: paneId,
        status: "skipped",
        reason: "topology_guard",
        error: guardReason
      });
      continue;
    }

    const result = runner(["kill-pane", "-t", paneId]);
    if (result.ok) {
      panes.push({
        pane_id: paneId,
        status: "killed"
      });
    } else {
      panes.push({
        pane_id: paneId,
        status: "failed",
        error: result.stderr || "tmux kill-pane failed"
      });
    }
  }

  return {
    panes,
    killed: panes.filter((pane) => pane.status === "killed").length,
    failed: panes.filter((pane) => pane.status === "failed").length,
    skipped: panes.filter((pane) => pane.status === "skipped").length
  };
}

export function notifyPane(paneId: string, message: string): boolean {
  if (!paneId.startsWith("%")) {
    return false;
  }

  const writeResult = runTmux(["send-keys", "-t", paneId, "-l", message]);
  if (!writeResult.ok) {
    return false;
  }

  const enterResult = runTmux(["send-keys", "-t", paneId, "C-m"]);
  return enterResult.ok;
}

export function createHudPane(
  spec: TmuxHudSpec,
  options: {
    targetPaneId?: string | null;
    runner?: TmuxRunner;
  } = {}
): string | null {
  const runner = options.runner ?? runTmux;
  const targetPaneId =
    Object.prototype.hasOwnProperty.call(options, "targetPaneId")
      ? options.targetPaneId
      : currentTmuxPaneId();
  if (!targetPaneId) {
    return null;
  }
  const panes = listTmuxPanes(runner);
  const reusable = panes.find(
    (pane) =>
      !pane.dead &&
      hudPaneMatchesOwner(pane, {
        teamName: spec.teamName,
        leaderPaneId: spec.leaderPaneId ?? targetPaneId,
        sessionId: spec.sessionId
      })
  );
  if (reusable) {
    return reusable.pane_id;
  }
  const hudResult = runner([
    "split-window",
    "-v",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-t",
    targetPaneId,
    "-c",
    spec.projectRoot,
    buildHudCommand(spec)
  ]);
  if (!hudResult.ok) {
    return null;
  }
  const paneId = hudResult.stdout.split("\n")[0]?.trim();
  if (!paneId || !paneId.startsWith("%")) {
    return null;
  }
  runner(["select-pane", "-t", paneId, "-T", `agmo:hud:${spec.teamName}`]);
  return paneId;
}

export function computeCurrentTeamLayoutPlan(
  leaderPaneId: string | null | undefined,
  workerCount: number,
  options: { preset?: TeamLayoutPreset; hud?: boolean; runner?: TmuxRunner } = {}
): TeamLayoutPlan {
  const panes = listTmuxPanes(options.runner ?? runTmux);
  const leader = leaderPaneId ? panes.find((pane) => pane.pane_id === leaderPaneId) : undefined;
  return computeTeamLayoutPlan(leader?.window_width, leader?.window_height, workerCount, {
    preset: options.preset,
    hud: options.hud
  });
}

export function applyTeamLayout(
  spec: {
    teamName: string;
    leaderPaneId?: string | null;
    sessionId?: string | null;
    workerPaneIds?: Record<string, string>;
    hudPaneId?: string | null;
    layout?: TeamLayoutPreset;
    dryRun?: boolean;
  },
  runner: TmuxRunner = runTmux
): TmuxLayoutOperationResult {
  const planned: TmuxLayoutAction[] = [];
  const performed: TmuxLayoutAction[] = [];
  const skipped: TmuxLayoutAction[] = [];
  const failed: Array<TmuxLayoutAction & { error: string }> = [];
  const refused: Array<TmuxLayoutAction & { reason: string }> = [];
  const panes = listTmuxPanes(runner);
  const leader = spec.leaderPaneId ? panes.find((pane) => pane.pane_id === spec.leaderPaneId) : undefined;
  const current = currentTmuxPaneInfo(runner);
  const plan = computeTeamLayoutPlan(
    leader?.window_width,
    leader?.window_height,
    Object.keys(spec.workerPaneIds ?? {}).length,
    { preset: spec.layout ?? "auto", hud: Boolean(spec.hudPaneId) }
  );

  if (!spec.leaderPaneId || !leader || leader.dead) {
    const action = { kind: "refuse", target: spec.leaderPaneId ?? "leader", reason: "leader_pane_unavailable" };
    return { status: "refused", layoutPlan: plan, planned: [action], performed, skipped, failed, refused: [{ ...action, reason: action.reason }] };
  }
  if (spec.sessionId && leader.session_id !== spec.sessionId) {
    const action = { kind: "refuse", target: spec.leaderPaneId, reason: "leader_pane_foreign_session" };
    return { status: "refused", layoutPlan: plan, planned: [action], performed, skipped, failed, refused: [{ ...action, reason: action.reason }] };
  }
  if (current?.pane_id === spec.leaderPaneId) {
    skipped.push({ kind: "select-pane", target: spec.leaderPaneId, reason: "leader_is_current_pane" });
  }

  const layoutName = plan.choice === "tiled" ? "tiled" : "main-vertical";
  planned.push({ kind: "select-layout", target: spec.leaderPaneId, reason: `apply_${layoutName}:${plan.selectedReason}` });
  if (layoutName === "main-vertical" && plan.leaderWidth) {
    planned.push({ kind: "resize-pane", target: spec.leaderPaneId, reason: `leader_width_${plan.leaderWidth}` });
  }

  if (spec.dryRun) {
    return { status: "skipped", layoutPlan: plan, planned, performed, skipped: [...skipped, ...planned], failed, refused };
  }

  for (const action of planned) {
    const result =
      action.kind === "resize-pane" && plan.leaderWidth
        ? runner(["resize-pane", "-t", action.target, "-x", String(plan.leaderWidth)])
        : runner(["select-layout", "-t", action.target, layoutName]);
    if (result.ok) {
      performed.push(action);
    } else {
      failed.push({ ...action, error: result.stderr || "tmux layout command failed" });
    }
  }

  return {
    status: failed.length > 0 ? (performed.length > 0 ? "partial" : "failed") : "completed",
    layoutPlan: plan,
    planned,
    performed,
    skipped,
    failed,
    refused
  };
}
