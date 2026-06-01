import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, join } from "node:path";
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

test("buildSessionStartContext includes wiki manifest by default and omits raw wisdom excerpts", async () => {
  await withTempHome(async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-session-start-wisdom-"));
    const project = basename(tempRoot);
    const vault = join(tempRoot, "vault");
    const captures = join(vault, ".agmo", "llm-wiki", "projects", project, "captures");
    await mkdir(captures, { recursive: true });
    await mkdir(join(tempRoot, ".agmo"), { recursive: true });
    await writeFile(join(tempRoot, ".agmo", "config.json"), JSON.stringify({ vault_root: vault }, null, 2));
    await writeFile(
      join(vault, ".agmo", "llm-wiki", "projects", `${project}.md`),
      "---\nupdated: 2026-05-31\n---\n# Project Capsule\n"
    );
    await writeFile(
      join(captures, "capture.md"),
      "---\ntitle: Startup Manifest Capture\n---\n# Capture\nFull body should stay lazy\n"
    );

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

    assert.match(context, /LLM Wiki Manifest/);
    assert.match(context, /Startup Manifest Capture/);
    assert.doesNotMatch(context, /Full body should stay lazy/);
    assert.doesNotMatch(context, /Project decision: Agmo owns startup wisdom context\./);
    assert.doesNotMatch(context, /Current issue: remove remaining startup dependency\./);
    assert.doesNotMatch(context, /Global learn: prefer compact JSON CLI outputs\./);
  });
});

test("buildSessionStartContext injects bounded full wiki context only when AGMO_CONTEXT_MODE=full", async () => {
  await withTempHome(async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-session-start-wiki-full-"));
    const project = basename(tempRoot);
    const vault = join(tempRoot, "vault");
    const captures = join(vault, ".agmo", "llm-wiki", "projects", project, "captures");
    await mkdir(captures, { recursive: true });
    await mkdir(join(tempRoot, ".agmo"), { recursive: true });
    await writeFile(
      join(tempRoot, ".agmo", "config.json"),
      JSON.stringify({ vault_root: vault, session_start: { mode: "debug" } }, null, 2)
    );
    await writeFile(
      join(captures, "capture.md"),
      "---\ntitle: Full Capture\n---\n# Capture\nFull wiki body is available\n"
    );

    const debugManifest = await buildSessionStartContext(tempRoot, {});
    assert.match(debugManifest, /LLM Wiki Manifest/);
    assert.doesNotMatch(debugManifest, /Full wiki body is available/);

    const full = await buildSessionStartContext(tempRoot, {
      AGMO_CONTEXT_MODE: "full",
      AGMO_CONTEXT_BUDGET_CHARS: "12000"
    });
    assert.match(full, /LLM Wiki Context/);
    assert.match(full, /Full wiki body is available/);
  });
});

test("buildSessionStartContext falls back to manifest with warning on invalid wiki budget env", async () => {
  await withTempHome(async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-session-start-wiki-invalid-"));
    const project = basename(tempRoot);
    const vault = join(tempRoot, "vault");
    const captures = join(vault, ".agmo", "llm-wiki", "projects", project, "captures");
    await mkdir(captures, { recursive: true });
    await mkdir(join(tempRoot, ".agmo"), { recursive: true });
    await writeFile(join(tempRoot, ".agmo", "config.json"), JSON.stringify({ vault_root: vault }, null, 2));
    await writeFile(
      join(captures, "capture.md"),
      "---\ntitle: Invalid Budget Capture\n---\n# Capture\nInvalid budget body\n"
    );

    const context = await buildSessionStartContext(tempRoot, {
      AGMO_CONTEXT_MODE: "full",
      AGMO_CONTEXT_BUDGET_CHARS: "0"
    });

    assert.match(context, /Wiki context warning: Ignoring invalid AGMO_CONTEXT_BUDGET_CHARS/);
    assert.match(context, /LLM Wiki Manifest/);
    assert.doesNotMatch(context, /Invalid budget body/);
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
