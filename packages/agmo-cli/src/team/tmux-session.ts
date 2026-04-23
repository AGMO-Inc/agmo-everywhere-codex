import { execFileSync } from "node:child_process";

export type TmuxTopology = {
  available: boolean;
  in_tmux_client: boolean;
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
  leaderPaneId: string;
  workerPaneIds: Record<string, string>;
  hudPaneId?: string | null;
};

export type TmuxHudSpec = {
  teamName: string;
  projectRoot: string;
  cliEntryPath: string;
  refreshMs?: number;
  clearScreen?: boolean;
};

function runTmux(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("tmux", args, { encoding: "utf-8" }).trim();
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

function buildWorkerBootstrapCommand(spec: TmuxWorkerPaneSpec): string {
  const prompt = [
    `You are ${spec.workerName} for team ${spec.teamName}.`,
    `Read the inbox file at ${spec.inboxPath} first.`,
    `Operate in the role ${spec.role}.`,
    `Follow the worker instructions in ${spec.instructionsPath}.`,
    `Current task summary: ${spec.taskSummary}.`
  ].join(" ");
  const args = [
    "codex",
    "--no-alt-screen",
    prompt
  ];
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

export function describeTmuxSessionTopology(workerCount: number): TmuxTopology {
  return {
    available: isTmuxAvailable(),
    in_tmux_client: Boolean(currentTmuxPaneId()),
    leader_pane_id: currentTmuxPaneId(),
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
  const leaderPaneId = currentTmuxPaneId();
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
    leaderPaneId,
    workerPaneIds,
    hudPaneId
  };
}

export function destroyWorkerPanes(paneIds: string[]): void {
  for (const paneId of paneIds) {
    if (!paneId.startsWith("%")) {
      continue;
    }
    runTmux(["kill-pane", "-t", paneId]);
  }
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
