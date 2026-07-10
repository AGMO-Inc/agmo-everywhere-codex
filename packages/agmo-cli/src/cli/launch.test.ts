import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CleanupPlanEntry, CleanupPlanSummary } from "../cleanup/plan.js";
import type { CleanupRunSummary } from "../cleanup/run.js";
import { prepareSessionWorkspace } from "../launch/session-workspace.js";
import { ensureCodexCliArgs } from "../utils/codex.js";
import { runSafeAutoCleanupBeforeLaunch, type LaunchAutoCleanupDeps } from "./launch.js";

test("ensureCodexCliArgs injects --full-auto when omitted", () => {
  assert.deepEqual(ensureCodexCliArgs([]), ["--full-auto"]);
  assert.deepEqual(ensureCodexCliArgs(["--full-auto"]), ["--full-auto"]);
  assert.deepEqual(ensureCodexCliArgs(["--yolo"]), ["--full-auto"]);
});

test("ensureCodexCliArgs supports madmax autonomy", () => {
  assert.deepEqual(ensureCodexCliArgs([], "madmax"), [
    "--dangerously-bypass-approvals-and-sandbox"
  ]);
  assert.deepEqual(ensureCodexCliArgs(["--madmax"]), [
    "--dangerously-bypass-approvals-and-sandbox"
  ]);
});

test("ensureCodexCliArgs preserves explicit modern autonomy flags", () => {
  const args = ["--dangerously-bypass-approvals-and-sandbox"];
  assert.deepEqual(ensureCodexCliArgs(args), args);
});

function cleanupPolicy(enabled: boolean, safeAutoCleanupOnLaunch: boolean) {
  return {
    policy: {
      enabled,
      dry_run_default: true,
      state_ttl_days: 30,
      workflow_state_ttl_days: 30,
      session_instructions_ttl_days: 7,
      handoff_ttl_days: 30,
      launch_workspace_ttl_hours: 24,
      cache_ttl_days: 7,
      max_project_agmo_bytes: 1_000_000_000,
      max_launch_workspace_bytes: 500_000_000,
      max_state_files: 1000,
      all_project_scan_max_depth: 5,
      safe_auto_cleanup_on_launch: safeAutoCleanupOnLaunch
    },
    sources: {
      project_config_path: "/tmp/project/.agmo/config.json",
      user_config_path: "/tmp/home/.agmo/config.json",
      effective: {}
    }
  } as Awaited<NonNullable<LaunchAutoCleanupDeps["resolveCleanupPolicy"]> extends (
    projectRoot: string
  ) => Promise<infer Result> ? Result : never>;
}

function entry(
  projectRoot: string,
  relativePath: string,
  category: CleanupPlanEntry["category"],
  reason: string,
  options: Partial<CleanupPlanEntry> = {}
): CleanupPlanEntry {
  return {
    category,
    path: join(projectRoot, relativePath),
    relative_path: relativePath,
    bytes: options.bytes ?? 10,
    mtime_ms: options.mtime_ms ?? 100,
    kind: options.kind ?? "directory",
    reason,
    ...(options.details ? { details: options.details } : {})
  };
}

function plan(
  projectRoot: string,
  wouldDelete: CleanupPlanEntry[],
  kept: CleanupPlanEntry[] = []
): CleanupPlanSummary {
  const inspectedEntries = wouldDelete.length + kept.length;
  const inspectedBytes = [...wouldDelete, ...kept].reduce((sum, item) => sum + item.bytes, 0);
  const wouldDeleteBytes = wouldDelete.reduce((sum, item) => sum + item.bytes, 0);
  const keptBytes = kept.reduce((sum, item) => sum + item.bytes, 0);
  const bytePressure = {
    target: null,
    before_bytes: inspectedBytes,
    after_bytes: inspectedBytes - wouldDeleteBytes,
    selected_entries: 0,
    selected_bytes: 0,
    skipped_ineligible_entries: kept.length,
    skipped_ineligible_bytes: keptBytes,
    reachable: true,
    unreachable_reason: null
  };

  return {
    project_root: projectRoot,
    agmo_dir: join(projectRoot, ".agmo"),
    policy: cleanupPolicy(true, true),
    options: {
      older_than_days: null,
      max_bytes: null
    },
    effective_caps: {
      max_launch_workspace_bytes: {
        configured: 0,
        enabled: false,
        effective: null
      },
      max_state_files: {
        configured: 0,
        enabled: false,
        effective: null
      },
      max_project_agmo_bytes: {
        configured: 0,
        enabled: false,
        explicit_override: null,
        effective: null
      }
    },
    pressure: {
      launch_workspace_bytes: bytePressure,
      state_files: {
        target: null,
        before_count: 0,
        after_count: 0,
        selected_entries: 0,
        pairs_selected: 0,
        skipped_ineligible_entries: 0,
        reachable: true,
        unreachable_reason: null
      },
      project_bytes: bytePressure
    },
    totals: {
      inspected_entries: inspectedEntries,
      inspected_bytes: inspectedBytes,
      would_delete_entries: wouldDelete.length,
      would_delete_bytes: wouldDeleteBytes,
      kept_entries: kept.length,
      kept_bytes: keptBytes,
      projected_bytes_after_delete: Math.max(inspectedBytes - wouldDeleteBytes, 0)
    },
    would_delete: wouldDelete,
    kept
  };
}

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

test("runSafeAutoCleanupBeforeLaunch is gated by cleanup policy", async () => {
  let createCalls = 0;
  let runCalls = 0;
  const stderr: string[] = [];

  await runSafeAutoCleanupBeforeLaunch("/tmp/project", {
    resolveCleanupPolicy: async () => cleanupPolicy(true, false),
    createCleanupPlan: async () => {
      createCalls += 1;
      return plan("/tmp/project", []);
    },
    runCleanupPlan: async (cleanupPlan) => {
      runCalls += 1;
      return { ...cleanupPlan, run: emptyRun(cleanupPlan) };
    },
    writeStderr: (message) => stderr.push(message)
  });
  await runSafeAutoCleanupBeforeLaunch("/tmp/project", {
    resolveCleanupPolicy: async () => cleanupPolicy(false, true),
    createCleanupPlan: async () => {
      createCalls += 1;
      return plan("/tmp/project", []);
    },
    runCleanupPlan: async (cleanupPlan) => {
      runCalls += 1;
      return { ...cleanupPlan, run: emptyRun(cleanupPlan) };
    },
    writeStderr: (message) => stderr.push(message)
  });

  assert.equal(createCalls, 0);
  assert.equal(runCalls, 0);
  assert.deepEqual(stderr, []);
});

function emptyRun(cleanupPlan: CleanupPlanSummary): CleanupRunSummary["run"] {
  return {
    removed: [],
    skipped: [],
    failures: [],
    totals: {
      planned_entries: cleanupPlan.would_delete.length,
      planned_bytes: cleanupPlan.would_delete.reduce((sum, item) => sum + item.bytes, 0),
      removed_entries: 0,
      removed_bytes: 0,
      skipped_entries: 0,
      failure_entries: 0
    }
  };
}

test("runSafeAutoCleanupBeforeLaunch filters to exact launch and paired session entries", async () => {
  const projectRoot = "/tmp/project";
  const launch = entry(
    projectRoot,
    ".agmo/cache/launch-workspaces/session-1",
    "cache/launch-workspaces",
    "inactive clean launch workspace older than retention threshold",
    { bytes: 100, details: { session_id: "session-1" } }
  );
  const sessionNew = entry(
    projectRoot,
    ".agmo/cache/session-instructions/session-1",
    "cache/session-instructions",
    "session instructions newer than retention threshold",
    { bytes: 30, details: { existing: true } }
  );
  const sibling = entry(
    projectRoot,
    ".agmo/cache/session-instructions/session-10",
    "cache/session-instructions",
    "session instructions older than retention threshold",
    { bytes: 40 }
  );
  const log = entry(
    projectRoot,
    ".agmo/logs/old.log",
    "logs",
    "Agmo log older than retention threshold",
    { bytes: 20, kind: "file" }
  );
  const first = plan(projectRoot, [launch, sibling, log], [sessionNew]);
  const second = plan(projectRoot, [launch, sibling, log], [sessionNew]);
  const plans = [first, second];
  const createArgs: string[] = [];
  const receivedPlans: CleanupPlanSummary[] = [];
  const stderr: string[] = [];

  await runSafeAutoCleanupBeforeLaunch(projectRoot, {
    resolveCleanupPolicy: async () => cleanupPolicy(true, true),
    createCleanupPlan: async (root) => {
      createArgs.push(root);
      return plans.shift() ?? assert.fail("unexpected extra planner call");
    },
    runCleanupPlan: async (cleanupPlan) => {
      receivedPlans.push(cleanupPlan);
      return { ...cleanupPlan, run: emptyRun(cleanupPlan) };
    },
    writeStderr: (message) => stderr.push(message)
  });

  assert.deepEqual(createArgs, [projectRoot, projectRoot]);
  assert.equal(receivedPlans.length, 1);
  const filteredPlan = receivedPlans[0] as CleanupPlanSummary;
  assert.deepEqual(
    filteredPlan.would_delete.map((item) => ({
      relative_path: item.relative_path,
      category: item.category,
      reason: item.reason,
      details: item.details
    })),
    [
      {
        relative_path: ".agmo/cache/launch-workspaces/session-1",
        category: "cache/launch-workspaces",
        reason: "inactive clean launch workspace older than retention threshold",
        details: { session_id: "session-1" }
      },
      {
        relative_path: ".agmo/cache/session-instructions/session-1",
        category: "cache/session-instructions",
        reason: "paired with expired clean launch workspace during opt-in launch auto-cleanup",
        details: {
          existing: true,
          auto_cleanup_original_reason: "session instructions newer than retention threshold"
        }
      }
    ]
  );
  assert.equal(filteredPlan.totals.would_delete_entries, 2);
  assert.equal(filteredPlan.totals.would_delete_bytes, 130);
  assert.equal(filteredPlan.totals.kept_entries, 2);
  assert.equal(filteredPlan.totals.kept_bytes, 60);
  assert.equal(filteredPlan.totals.projected_bytes_after_delete, 60);
  assert.deepEqual(stderr, []);
});

test("runSafeAutoCleanupBeforeLaunch requires launch path, relative path, and session id to revalidate", async () => {
  const projectRoot = "/tmp/project";
  const firstLaunch = entry(
    projectRoot,
    ".agmo/cache/launch-workspaces/session-1",
    "cache/launch-workspaces",
    "inactive clean launch workspace older than retention threshold",
    { details: { session_id: "session-1" } }
  );
  const secondCollision = entry(
    projectRoot,
    ".agmo/cache/launch-workspaces/session-renamed",
    "cache/launch-workspaces",
    "inactive clean launch workspace older than retention threshold",
    { details: { session_id: "session-1" } }
  );
  const plans = [plan(projectRoot, [firstLaunch]), plan(projectRoot, [secondCollision])];
  let runCalled = false;

  await runSafeAutoCleanupBeforeLaunch(projectRoot, {
    resolveCleanupPolicy: async () => cleanupPolicy(true, true),
    createCleanupPlan: async () => plans.shift() ?? assert.fail("unexpected extra planner call"),
    runCleanupPlan: async (cleanupPlan) => {
      runCalled = true;
      return { ...cleanupPlan, run: emptyRun(cleanupPlan) };
    },
    writeStderr: () => assert.fail("identity mismatch drops should be silent")
  });

  assert.equal(runCalled, false);
});

test("runSafeAutoCleanupBeforeLaunch drops candidates that fail the second planner pass", async () => {
  const projectRoot = "/tmp/project";
  const firstLaunch = entry(
    projectRoot,
    ".agmo/cache/launch-workspaces/session-1",
    "cache/launch-workspaces",
    "inactive clean launch workspace older than retention threshold",
    { details: { session_id: "session-1" } }
  );
  const secondLaunch = entry(
    projectRoot,
    ".agmo/cache/launch-workspaces/session-1",
    "cache/launch-workspaces",
    "dirty launch workspace",
    { details: { session_id: "session-1" } }
  );
  const plans = [plan(projectRoot, [firstLaunch]), plan(projectRoot, [], [secondLaunch])];
  let runCalled = false;

  await runSafeAutoCleanupBeforeLaunch(projectRoot, {
    resolveCleanupPolicy: async () => cleanupPolicy(true, true),
    createCleanupPlan: async () => plans.shift() ?? assert.fail("unexpected extra planner call"),
    runCleanupPlan: async (cleanupPlan) => {
      runCalled = true;
      return { ...cleanupPlan, run: emptyRun(cleanupPlan) };
    },
    writeStderr: () => assert.fail("fresh revalidation drops should be silent")
  });

  assert.equal(runCalled, false);
});

test("runSafeAutoCleanupBeforeLaunch rejects unsafe session ids and size-cap session instructions", async () => {
  const projectRoot = "/tmp/project";
  const unsafeLaunch = entry(
    projectRoot,
    ".agmo/cache/launch-workspaces/session-unsafe",
    "cache/launch-workspaces",
    "inactive clean launch workspace older than retention threshold",
    { details: { session_id: "../session-unsafe" } }
  );
  const safeLaunch = entry(
    projectRoot,
    ".agmo/cache/launch-workspaces/session-1",
    "cache/launch-workspaces",
    "inactive clean launch workspace older than retention threshold",
    { details: { session_id: "session-1" } }
  );
  const sizeCapSession = entry(
    projectRoot,
    ".agmo/cache/session-instructions/session-1",
    "cache/session-instructions",
    "selected by project size cap"
  );
  const plans = [
    plan(projectRoot, [unsafeLaunch]),
    plan(projectRoot, [unsafeLaunch]),
    plan(projectRoot, [safeLaunch, sizeCapSession]),
    plan(projectRoot, [safeLaunch, sizeCapSession])
  ];
  const receivedPlans: CleanupPlanSummary[] = [];

  await runSafeAutoCleanupBeforeLaunch(projectRoot, {
    resolveCleanupPolicy: async () => cleanupPolicy(true, true),
    createCleanupPlan: async () => plans.shift() ?? assert.fail("unexpected extra planner call"),
    runCleanupPlan: async (cleanupPlan) => {
      receivedPlans.push(cleanupPlan);
      return { ...cleanupPlan, run: emptyRun(cleanupPlan) };
    },
    writeStderr: () => assert.fail("unsafe session matching should be silent")
  });
  await runSafeAutoCleanupBeforeLaunch(projectRoot, {
    resolveCleanupPolicy: async () => cleanupPolicy(true, true),
    createCleanupPlan: async () => plans.shift() ?? assert.fail("unexpected extra planner call"),
    runCleanupPlan: async (cleanupPlan) => {
      receivedPlans.push(cleanupPlan);
      return { ...cleanupPlan, run: emptyRun(cleanupPlan) };
    },
    writeStderr: () => assert.fail("size-cap exclusion should be silent")
  });

  assert.equal(receivedPlans.length, 1);
  assert.deepEqual(
    receivedPlans[0]?.would_delete.map((item) => item.relative_path),
    [".agmo/cache/launch-workspaces/session-1"]
  );
});

test("runSafeAutoCleanupBeforeLaunch rejects cap-selected launch workspaces", async () => {
  const projectRoot = "/tmp/project";
  const capLaunch = entry(
    projectRoot,
    ".agmo/cache/launch-workspaces/session-1",
    "cache/launch-workspaces",
    "selected by launch workspace byte cap",
    { details: { session_id: "session-1" } }
  );
  const plans = [plan(projectRoot, [capLaunch]), plan(projectRoot, [capLaunch])];
  let runCalled = false;

  await runSafeAutoCleanupBeforeLaunch(projectRoot, {
    resolveCleanupPolicy: async () => cleanupPolicy(true, true),
    createCleanupPlan: async () => plans.shift() ?? assert.fail("unexpected extra planner call"),
    runCleanupPlan: async (cleanupPlan) => {
      runCalled = true;
      return { ...cleanupPlan, run: emptyRun(cleanupPlan) };
    },
    writeStderr: () => assert.fail("cap-selected launch cleanup should be silent")
  });

  assert.equal(runCalled, false);
});

test("runSafeAutoCleanupBeforeLaunch treats failures as nonfatal bounded stderr", async () => {
  const projectRoot = "/tmp/project";
  const longMessage = "x".repeat(500);
  const stderr: string[] = [];

  await runSafeAutoCleanupBeforeLaunch(projectRoot, {
    resolveCleanupPolicy: async () => {
      throw new Error(longMessage);
    },
    writeStderr: (message) => stderr.push(message)
  });

  assert.equal(stderr.length, 1);
  assert.match(stderr[0] ?? "", /^\[agmo launch\] auto-cleanup skipped: x+\.\.\.\n$/);
  assert.ok((stderr[0] ?? "").length < 250);

  stderr.length = 0;
  const launch = entry(
    projectRoot,
    ".agmo/cache/launch-workspaces/session-1",
    "cache/launch-workspaces",
    "inactive clean launch workspace older than retention threshold",
    { details: { session_id: "session-1" } }
  );
  const cleanupPlan = plan(projectRoot, [launch]);

  await runSafeAutoCleanupBeforeLaunch(projectRoot, {
    resolveCleanupPolicy: async () => cleanupPolicy(true, true),
    createCleanupPlan: async () => cleanupPlan,
    runCleanupPlan: async (filteredPlan) => ({
      ...filteredPlan,
      run: {
        ...emptyRun(filteredPlan),
        failures: [
          {
            path: launch.path,
            relative_path: launch.relative_path,
            category: launch.category,
            bytes: launch.bytes,
            reason: launch.reason,
            kind: launch.kind,
            error: "permission denied"
          }
        ],
        totals: {
          ...emptyRun(filteredPlan).totals,
          failure_entries: 1
        }
      }
    }),
    writeStderr: (message) => stderr.push(message)
  });

  assert.deepEqual(stderr, [
    "[agmo launch] auto-cleanup incomplete: removed=0 skipped=0 failures=1 first=.agmo/cache/launch-workspaces/session-1: permission denied\n"
  ]);
});

test("runSafeAutoCleanupBeforeLaunch bounds and sanitizes incomplete stderr path", async () => {
  const projectRoot = "/tmp/project";
  const stderr: string[] = [];
  const launch = entry(
    projectRoot,
    `.agmo/cache/launch-workspaces/${"nested\npath".repeat(40)}`,
    "cache/launch-workspaces",
    "inactive clean launch workspace older than retention threshold",
    { details: { session_id: "session-1" } }
  );
  const cleanupPlan = plan(projectRoot, [launch]);

  await runSafeAutoCleanupBeforeLaunch(projectRoot, {
    resolveCleanupPolicy: async () => cleanupPolicy(true, true),
    createCleanupPlan: async () => cleanupPlan,
    runCleanupPlan: async (filteredPlan) => ({
      ...filteredPlan,
      run: {
        ...emptyRun(filteredPlan),
        failures: [
          {
            path: launch.path,
            relative_path: launch.relative_path,
            category: launch.category,
            bytes: launch.bytes,
            reason: launch.reason,
            kind: launch.kind,
            error: `permission\ndenied ${"x".repeat(300)}`
          }
        ],
        totals: {
          ...emptyRun(filteredPlan).totals,
          failure_entries: 1
        }
      }
    }),
    writeStderr: (message) => stderr.push(message)
  });

  assert.equal(stderr.length, 1);
  assert.equal(stderr[0]?.endsWith("\n"), true);
  assert.equal((stderr[0]?.match(/\n/g) ?? []).length, 1);
  assert.ok((stderr[0] ?? "").length <= 241);
  assert.match(stderr[0] ?? "", /^\[agmo launch\] auto-cleanup incomplete: /);
});

test("runSafeAutoCleanupBeforeLaunch default dependencies remove stale clean launch workspace and paired instructions", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agmo-launch-default-cleanup-"));

  try {
    runGit(["init", "-b", "main"], projectRoot);
    runGit(["config", "user.name", "Agmo Test"], projectRoot);
    runGit(["config", "user.email", "agmo@example.com"], projectRoot);
    await writeFile(join(projectRoot, "AGENTS.md"), "# Project\n", "utf8");
    runGit(["add", "."], projectRoot);
    runGit(["commit", "-m", "initial"], projectRoot);

    await mkdir(join(projectRoot, ".agmo"), { recursive: true });
    await writeFile(
      join(projectRoot, ".agmo", "config.json"),
      `${JSON.stringify(
        {
          cleanup: {
            enabled: true,
            safe_auto_cleanup_on_launch: true,
            launch_workspace_ttl_hours: 1,
            session_instructions_ttl_days: 7
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const workspace = await prepareSessionWorkspace({ projectRoot, sessionId: "session-1" });
    const oldIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const metadata = JSON.parse(await readFile(workspace.metadataPath, "utf8")) as Record<string, unknown>;
    await writeFile(
      workspace.metadataPath,
      `${JSON.stringify({ ...metadata, active: false, last_exit_at: oldIso }, null, 2)}\n`,
      "utf8"
    );

    await runSafeAutoCleanupBeforeLaunch(projectRoot);

    assert.equal(existsSync(workspace.workspaceDir), false);
    assert.equal(existsSync(join(projectRoot, ".agmo", "cache", "session-instructions", "session-1")), false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
