import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSessionStartContext } from "./session-start.js";
import { startTeamRuntime } from "../team/runtime.js";
import { resolveInstallPaths } from "../utils/paths.js";
import { addWisdomEntry } from "../wisdom/store.js";

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const tempHome = await mkdtemp(join(os.tmpdir(), "agmo-session-start-home-"));
  process.env.HOME = tempHome;

  try {
    return await fn();
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
}

test("buildSessionStartContext prioritizes current-session teams and hides unrelated team names", async () => {
  await withTempHome(async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-session-start-current-"));

    await startTeamRuntime(
      {
        teamName: "current-session-team-a",
        workerCount: 1,
        task: "Current session team A",
        mode: "interactive",
        sessionId: "session-123"
      },
      tempRoot
    );
    await startTeamRuntime(
      {
        teamName: "current-session-team-b",
        workerCount: 1,
        task: "Current session team B",
        mode: "interactive",
        sessionId: "session-123"
      },
      tempRoot
    );
    await startTeamRuntime(
      {
        teamName: "older-session-team",
        workerCount: 1,
        task: "Older session team",
        mode: "interactive",
        sessionId: "session-999"
      },
      tempRoot
    );

    const context = await buildSessionStartContext(tempRoot, {}, { session_id: "session-123" });

    assert.match(context, /Team session: current-session team snapshots:/);
    assert.match(context, /current-session-team-a \[active, workers=1\]/);
    assert.match(context, /current-session-team-b \[active, workers=1\]/);
    assert.match(context, /1 (?:other|unrelated) active team snapshot[s]? hidden/);
    assert.doesNotMatch(context, /older-session-team \[active, workers=1\]/);
  });
});

test("buildSessionStartContext hides unrelated active team names when no current session is known", async () => {
  await withTempHome(async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-session-start-hidden-"));

    await startTeamRuntime(
      {
        teamName: "hidden-team-a",
        workerCount: 1,
        task: "Hidden team A",
        mode: "interactive",
        sessionId: "session-aaa"
      },
      tempRoot
    );
    await startTeamRuntime(
      {
        teamName: "hidden-team-b",
        workerCount: 1,
        task: "Hidden team B",
        mode: "interactive",
        sessionId: "session-bbb"
      },
      tempRoot
    );

    const context = await buildSessionStartContext(tempRoot);

    assert.match(context, /Team session: no current worker session; 2 active team snapshots hidden\./);
    assert.doesNotMatch(context, /hidden-team-a \[active, workers=1\]/);
    assert.doesNotMatch(context, /hidden-team-b \[active, workers=1\]/);
  });
});

test("buildSessionStartContext merges global and project wisdom into Agmo bootstrap output", async () => {
  await withTempHome(async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-session-start-wisdom-"));

    await addWisdomEntry({
      scope: "user",
      kind: "learn",
      content: "Global learn: prefer compact JSON CLI outputs.",
      cwd: tempRoot
    });
    await addWisdomEntry({
      scope: "project",
      kind: "decision",
      content: "Project decision: Agmo owns startup wisdom context.",
      cwd: tempRoot
    });
    await addWisdomEntry({
      scope: "project",
      kind: "issue",
      content: "Current issue: remove remaining startup dependency.",
      cwd: tempRoot
    });

    const context = await buildSessionStartContext(tempRoot);

    assert.match(context, /Wisdom memory: loaded 3 entries \(global=1, project=2\)\./);
    assert.match(context, /decisions: \[project\] Project decision: Agmo owns startup wisdom context\./);
    assert.match(context, /issues: \[project\] Current issue: remove remaining startup dependency\./);
    assert.match(context, /learns: \[global\] Global learn: prefer compact JSON CLI outputs\./);
  });
});

test("buildSessionStartContext hides stale older workflow snapshots using launch heartbeat policy", async () => {
  await withTempHome(async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-session-start-workflows-"));
    const { agmoConfigFile, workflowsStateDir } = resolveInstallPaths("project", tempRoot);
    const now = Date.now();

    await mkdir(join(tempRoot, ".agmo"), { recursive: true });
    await writeFile(
      agmoConfigFile,
      `${JSON.stringify({ launch: { heartbeat_stale_after_ms: 60_000 } }, null, 2)}\n`
    );
    await mkdir(workflowsStateDir, { recursive: true });
    await writeFile(
      join(workflowsStateDir, "fresh-session.json"),
      `${JSON.stringify(
        {
          version: 1,
          session_id: "fresh-session",
          active: true,
          workflow: "fresh-workflow",
          last_event: "PostToolUse",
          updated_at: new Date(now - 5_000).toISOString()
        },
        null,
        2
      )}\n`
    );
    await writeFile(
      join(workflowsStateDir, "stale-session.json"),
      `${JSON.stringify(
        {
          version: 1,
          session_id: "stale-session",
          active: true,
          workflow: "stale-workflow",
          last_event: "PostToolUse",
          updated_at: new Date(now - 5 * 60_000).toISOString()
        },
        null,
        2
      )}\n`
    );

    const context = await buildSessionStartContext(tempRoot);

    assert.match(context, /Workflow state: fresh-workflow \(active\)/);
    assert.doesNotMatch(context, /stale-workflow \(active\)/);
  });
});
