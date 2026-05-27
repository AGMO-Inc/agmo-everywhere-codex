import { execFileSync } from "node:child_process";
import { ensureCodexCliArgs, normalizeCodexAutonomyMode } from "../utils/codex.js";

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

function buildHudCommand(spec: TmuxHudSpec): string {
  const refreshMs = Math.max(spec.refreshMs ?? 2000, 250);
  const intervalSeconds = (refreshMs / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  const clearPrefix = spec.clearScreen === false ? "" : "clear; ";
  const hudCmd = `cd ${shellQuote(spec.projectRoot)} && while true; do ${clearPrefix}node ${shellQuote(spec.cliEntryPath)} team hud ${shellQuote(spec.teamName)}; sleep ${intervalSeconds}; done`;
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

export function listTmuxPanes(runner: TmuxRunner = runTmux): TmuxPaneInfo[] {
  const result = runner([
    "list-panes",
    "-a",
    "-F",
    "#{session_id}\t#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_active}\t#{pane_dead}\t#{pane_current_command}"
  ]);
  if (!result.ok || !result.stdout.trim()) {
    return [];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [sessionId, sessionName, windowId, paneId, active, dead, command] = line.split("\t");
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
          command: command ?? ""
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
  } = {}
): CreatedTmuxSession {
  const current = currentTmuxPaneInfo();
  const leaderPaneId = current?.pane_id ?? currentTmuxPaneId();
  if (!leaderPaneId) {
    throw new Error("tmux current pane not detected");
  }

  const workerPaneIds: Record<string, string> = {};
  let rightStackRootPaneId: string | null = null;

  for (let index = 0; index < workerSpecs.length; index += 1) {
    const spec = workerSpecs[index];
    const splitDirection = index === 0 ? "-h" : "-v";
    const splitTarget = index === 0 ? leaderPaneId : rightStackRootPaneId ?? leaderPaneId;
    const command = buildWorkerBootstrapCommand(spec);
    const result = runTmux([
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
    if (index === 0) {
      rightStackRootPaneId = paneId;
    }
  }

  let hudPaneId: string | null = null;
  if (options.hud) {
    const hudResult = runTmux([
      "split-window",
      "-v",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      leaderPaneId,
      "-c",
      options.hud.projectRoot,
      buildHudCommand(options.hud)
    ]);
    if (hudResult.ok) {
      const paneId = hudResult.stdout.split("\n")[0]?.trim();
      hudPaneId = paneId && paneId.startsWith("%") ? paneId : null;
    }
  }

  runTmux(["select-layout", "-t", leaderPaneId, "main-vertical"]);
  runTmux(["select-pane", "-t", leaderPaneId]);

  return {
    sessionId: current?.session_id ?? null,
    leaderPaneId,
    workerPaneIds,
    hudPaneId
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
  return paneId && paneId.startsWith("%") ? paneId : null;
}
