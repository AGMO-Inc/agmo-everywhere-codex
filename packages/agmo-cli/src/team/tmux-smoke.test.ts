import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cleanupStaleTeamRuntimes,
  readTeamStatus,
  readTeamTmuxHealthSummary,
  shutdownTeamRuntime,
  startTeamRuntime
} from "./runtime.js";
import {
  resolveTeamConfigPath,
  resolveWorkerIdentityPath
} from "./state/index.js";
import { agmoCliDistEntryPath } from "../utils/paths.js";

function tmux(args: string[]): string {
  return execFileSync("tmux", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function agmoCliJson(args: string[], cwd: string): unknown {
  return JSON.parse(
    execFileSync(process.execPath, [agmoCliDistEntryPath(), ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    })
  ) as unknown;
}

function canUseTmux(): { ok: true } | { ok: false; reason: string } {
  try {
    tmux(["-V"]);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "tmux executable unavailable"
    };
  }

  const sessionName = `agmo-smoke-probe-${Date.now().toString(36)}`;
  try {
    tmux(["new-session", "-d", "-s", sessionName, "sleep 1"]);
    tmux(["kill-session", "-t", sessionName]);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "tmux server unavailable"
    };
  }
}

test("optional tmux lifecycle smoke preserves leader and repairs HUD", async (t) => {
  const tmuxCheck = canUseTmux();
  if (!tmuxCheck.ok) {
    t.skip(`tmux smoke skipped: ${tmuxCheck.reason}`);
    return;
  }

  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-tmux-smoke-"));
  const suffix = Date.now().toString(36);
  const teamName = `tmux-smoke-${suffix}`;
  const sessionName = `agmo-smoke-${suffix}`;
  let sessionCreated = false;

  try {
    await startTeamRuntime(
      {
        teamName,
        workerCount: 1,
        task: "tmux lifecycle smoke",
        mode: "interactive",
        hud: true,
        hudRefreshMs: 1000,
        hudClearScreen: false
      },
      tempRoot
    );

    tmux(["new-session", "-d", "-s", sessionName, "-n", "agmo-smoke", "-c", tempRoot, "sleep 600"]);
    sessionCreated = true;
    const [sessionId, leaderPaneId] = tmux([
      "display-message",
      "-p",
      "-t",
      sessionName,
      "-F",
      "#{session_id}\t#{pane_id}"
    ]).split("\t");
    const workerPaneId = tmux([
      "split-window",
      "-h",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      leaderPaneId,
      "-c",
      tempRoot,
      "sleep 600"
    ]).split("\n")[0]?.trim();
    assert.ok(sessionId);
    assert.ok(leaderPaneId);
    assert.ok(workerPaneId);

    const configPath = resolveTeamConfigPath(teamName, tempRoot);
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      transport: string;
      tmux: {
        available: boolean;
        in_tmux_client: boolean;
        session_id?: string | null;
        leader_pane_id: string | null;
        worker_pane_ids: Record<string, string>;
        hud_pane_id?: string | null;
        hud_refresh_ms?: number | null;
        hud_clear_screen?: boolean;
      };
    };
    config.transport = "tmux";
    config.tmux.available = true;
    config.tmux.in_tmux_client = true;
    config.tmux.session_id = sessionId;
    config.tmux.leader_pane_id = leaderPaneId;
    config.tmux.worker_pane_ids = {
      "worker-1": workerPaneId
    };
    config.tmux.hud_pane_id = "%999999";
    config.tmux.hud_refresh_ms = 1000;
    config.tmux.hud_clear_screen = false;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const identityPath = resolveWorkerIdentityPath(teamName, "worker-1", tempRoot);
    const identity = JSON.parse(await readFile(identityPath, "utf8")) as {
      pane_id?: string;
    };
    identity.pane_id = workerPaneId;
    await writeFile(identityPath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");

    const beforeRepair = await readTeamTmuxHealthSummary(teamName, tempRoot);
    assert.equal(beforeRepair?.leader, "live");
    assert.equal(beforeRepair?.hud, "missing");
    assert.equal(beforeRepair?.workers["worker-1"], "live");

    const layoutStatus = agmoCliJson(["team", "layout", "status", teamName], tempRoot) as {
      layout_health: string;
      panes: {
        leader: { health: string };
        hud: { health: string };
        workers: Record<string, { health: string }>;
      };
    };
    assert.equal(layoutStatus.layout_health, "repairable");
    assert.equal(layoutStatus.panes.leader.health, "live");
    assert.equal(layoutStatus.panes.hud.health, "missing");
    assert.equal(layoutStatus.panes.workers["worker-1"]?.health, "live");

    const repairDryRun = agmoCliJson(["team", "layout", "repair", teamName, "--dry-run"], tempRoot) as {
      dry_run: boolean;
      status: string;
      planned: Array<{ kind: string }>;
      performed: Array<{ kind: string }>;
    };
    assert.equal(repairDryRun.dry_run, true);
    assert.equal(repairDryRun.status, "skipped");
    assert.ok(repairDryRun.planned.some((entry) => entry.kind === "repair-hud"));
    assert.equal(repairDryRun.performed.length, 0);

    const layoutRepair = agmoCliJson(["team", "layout", "repair", teamName, "--force"], tempRoot) as {
      status: string;
      performed: Array<{ kind: string; target: string }>;
    };
    assert.equal(layoutRepair.status, "completed");
    const repairedHud = layoutRepair.performed.find((entry) => entry.kind === "repair-hud");
    assert.ok(repairedHud?.target);

    const afterRepair = await readTeamTmuxHealthSummary(teamName, tempRoot);
    assert.equal(afterRepair?.leader, "live");
    assert.equal(afterRepair?.hud, "live");
    assert.equal(afterRepair?.layout, "ok");

    const rebalanceDryRun = agmoCliJson(
      ["team", "layout", "rebalance", teamName, "--layout", "auto", "--dry-run"],
      tempRoot
    ) as {
      dry_run: boolean;
      status: string;
      planned: Array<{ kind: string }>;
      performed: Array<{ kind: string }>;
    };
    assert.equal(rebalanceDryRun.dry_run, true);
    assert.equal(rebalanceDryRun.status, "skipped");
    assert.ok(rebalanceDryRun.planned.some((entry) => entry.kind === "select-layout"));
    assert.equal(rebalanceDryRun.performed.length, 0);

    const rebalance = agmoCliJson(
      ["team", "layout", "rebalance", teamName, "--layout", "main-vertical"],
      tempRoot
    ) as {
      status: string;
      performed: Array<{ kind: string }>;
      failed: Array<{ kind: string }>;
    };
    assert.equal(rebalance.status, "completed");
    assert.ok(rebalance.performed.some((entry) => entry.kind === "select-layout"));
    assert.equal(rebalance.failed.length, 0);

    const shutdown = await shutdownTeamRuntime(teamName, { graceMs: 0 }, tempRoot);
    assert.equal((shutdown.tmux_pane_destruction as { killed: number }).killed, 2);
    assert.equal((shutdown.tmux_pane_destruction as { failed: number }).failed, 0);

    const remainingPanes = tmux(["list-panes", "-t", sessionName, "-F", "#{pane_id}"])
      .split("\n")
      .filter(Boolean);
    assert.ok(remainingPanes.includes(leaderPaneId));
    assert.ok(!remainingPanes.includes(workerPaneId));
    assert.ok(!remainingPanes.includes(repairedHud.target));

    const cleanup = await cleanupStaleTeamRuntimes(
      {
        sweepTmux: true,
        dryRun: true
      },
      tempRoot
    );
    assert.ok(cleanup.tmux_sweep.stale_panes.some((entry) => entry.team_name === teamName));

    const finalStatus = await readTeamStatus(teamName, tempRoot);
    assert.equal(finalStatus?.config.active, false);
  } finally {
    if (sessionCreated) {
      try {
        tmux(["kill-session", "-t", sessionName]);
      } catch {
        // The disposable smoke session may already be gone.
      }
    }
  }
});
