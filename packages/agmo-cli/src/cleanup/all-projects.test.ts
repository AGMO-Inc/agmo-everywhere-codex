import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  createAllProjectsCleanupPlan,
  runAllProjectsCleanup,
  runAllProjectsCleanupPlan,
  type AllProjectsCleanupPlan
} from "./all-projects.js";

const DAY_MS = 24 * 60 * 60 * 1000;

async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  process.env.HOME = home;
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

async function writeRegistry(home: string, projectRoots: string[]): Promise<string> {
  const registryPath = join(home, ".agmo", "state", "cleanup", "projects.json");
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(
    registryPath,
    `${JSON.stringify(
      {
        version: 1,
        updated_at: "2026-01-01T00:00:00.000Z",
        projects: projectRoots.map((projectRoot) => ({
          project_root: projectRoot,
          agmo_dir: join(projectRoot, ".agmo"),
          discovered_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          source: "discover"
        }))
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return registryPath;
}

async function createProject(args: {
  parent: string;
  name: string;
  logName?: string;
  logContent?: string;
  ageDays?: number;
  cleanupConfig?: Record<string, unknown>;
}): Promise<{ root: string; realRoot: string; logPath: string }> {
  const root = join(args.parent, args.name);
  const logName = args.logName ?? "old.log";
  const logPath = join(root, ".agmo", "logs", logName);
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(
    join(root, ".agmo", "config.json"),
    `${JSON.stringify(args.cleanupConfig ? { cleanup: args.cleanupConfig } : {}, null, 2)}\n`,
    "utf8"
  );
  await writeFile(logPath, args.logContent ?? `${args.name}\n`, "utf8");
  if (args.ageDays !== undefined) {
    const oldDate = new Date(Date.now() - args.ageDays * DAY_MS);
    await utimes(logPath, oldDate, oldDate);
  }
  return { root, realRoot: await realpath(root), logPath };
}

function registryStats(path: string): { size: number; mtimeMs: number } {
  const stats = statSync(path);
  return { size: stats.size, mtimeMs: stats.mtimeMs };
}

async function fileSnapshot(path: string): Promise<{ size: number; mtimeMs: number; content: Buffer }> {
  return { ...registryStats(path), content: await readFile(path) };
}

function sumProjectTotals(plan: AllProjectsCleanupPlan): AllProjectsCleanupPlan["totals"] {
  return {
    projects: plan.projects.length,
    skipped_projects: plan.skipped_projects.length,
    inspected_entries: plan.projects.reduce((sum, project) => sum + project.totals.inspected_entries, 0),
    inspected_bytes: plan.projects.reduce((sum, project) => sum + project.totals.inspected_bytes, 0),
    would_delete_entries: plan.projects.reduce((sum, project) => sum + project.totals.would_delete_entries, 0),
    would_delete_bytes: plan.projects.reduce((sum, project) => sum + project.totals.would_delete_bytes, 0),
    kept_entries: plan.projects.reduce((sum, project) => sum + project.totals.kept_entries, 0),
    kept_bytes: plan.projects.reduce((sum, project) => sum + project.totals.kept_bytes, 0),
    projected_bytes_after_delete: plan.projects.reduce(
      (sum, project) => sum + project.totals.projected_bytes_after_delete,
      0
    )
  };
}

test("createAllProjectsCleanupPlan reads only registry entries and does not mutate registry or candidates", async () => {
  const parent = await mkdtemp(join(os.tmpdir(), "agmo-all-projects-plan-"));
  const home = await mkdtemp(join(os.tmpdir(), "agmo-all-projects-home-"));
  const registered = await createProject({ parent, name: "registered", ageDays: 10 });
  const unregistered = await createProject({ parent, name: "unregistered", ageDays: 10 });
  const registryPath = await writeRegistry(home, [registered.root]);
  const beforeRegistry = await fileSnapshot(registryPath);
  const beforeCandidate = await fileSnapshot(registered.logPath);

  const plan = await withHome(home, () =>
    createAllProjectsCleanupPlan({ cwd: parent, olderThanDays: 1, nowMs: Date.now() })
  );

  assert.equal(plan.registry_path, registryPath);
  assert.equal(plan.totals.projects, 1);
  assert.deepEqual(plan.projects.map((project) => project.project_root), [registered.realRoot]);
  assert.equal(plan.projects[0]?.would_delete[0]?.relative_path, ".agmo/logs/old.log");
  assert.equal(typeof plan.projects[0]?.effective_caps.max_project_agmo_bytes.effective, "number");
  assert.equal(typeof plan.projects[0]?.pressure.project_bytes.target, "number");
  assert.equal("pressure" in plan, false);
  assert.equal(existsSync(unregistered.logPath), true);
  assert.deepEqual(await fileSnapshot(registryPath), beforeRegistry);
  assert.deepEqual(await fileSnapshot(registered.logPath), beforeCandidate);
  assert.deepEqual(plan.totals, sumProjectTotals(plan));
});

test("aggregate planning shares one clock and options while retaining each project policy", async () => {
  const parent = await mkdtemp(join(os.tmpdir(), "agmo-all-projects-clock-"));
  const home = await mkdtemp(join(os.tmpdir(), "agmo-all-projects-clock-home-"));
  const nowMs = Date.UTC(2026, 0, 10);
  const borderline = new Date(nowMs - DAY_MS + 1000);
  const first = await createProject({
    parent,
    name: "a",
    cleanupConfig: { cache_ttl_days: 99 }
  });
  const second = await createProject({
    parent,
    name: "b",
    cleanupConfig: { cache_ttl_days: 3 }
  });
  await utimes(first.logPath, borderline, borderline);
  await utimes(second.logPath, borderline, borderline);
  await writeRegistry(home, [second.root, first.root]);

  const plan = await withHome(home, () =>
    createAllProjectsCleanupPlan({ cwd: parent, olderThanDays: 1, maxBytes: 1_000_000, nowMs })
  );

  assert.deepEqual(
    plan.projects.map((project) => project.project_root),
    [first.realRoot, second.realRoot]
  );
  assert.deepEqual(
    plan.projects.map((project) => project.options),
    [
      { older_than_days: 1, max_bytes: 1_000_000 },
      { older_than_days: 1, max_bytes: 1_000_000 }
    ]
  );
  assert.deepEqual(
    plan.projects.map((project) => project.totals.would_delete_entries),
    [0, 0]
  );
  assert.equal(plan.projects[0]?.policy.policy.cache_ttl_days, 99);
  assert.equal(plan.projects[1]?.policy.policy.cache_ttl_days, 3);
});

test("runAllProjectsCleanupPlan executes the retained policy and config from the original plan", async () => {
  const parent = await mkdtemp(join(os.tmpdir(), "agmo-all-projects-retained-plan-"));
  const home = await mkdtemp(join(os.tmpdir(), "agmo-all-projects-retained-plan-home-"));
  const nowMs = Date.UTC(2026, 0, 10);
  const oldDate = new Date(nowMs - 10 * DAY_MS);
  const project = await createProject({
    parent,
    name: "retained",
    logContent: "retained log\n",
    cleanupConfig: { cache_ttl_days: 99 }
  });
  await utimes(project.logPath, oldDate, oldDate);
  await writeRegistry(home, [project.root]);
  const beforeLog = await fileSnapshot(project.logPath);

  const retainedPlan = await withHome(home, () => createAllProjectsCleanupPlan({ cwd: parent, nowMs }));
  assert.equal(retainedPlan.options.older_than_days, null);
  assert.deepEqual(retainedPlan.projects[0]?.would_delete, []);
  assert.deepEqual(
    retainedPlan.projects[0]?.kept.map((entry) => entry.relative_path),
    [".agmo/logs/old.log"]
  );
  assert.equal(retainedPlan.projects[0]?.policy.policy.cache_ttl_days, 99);

  await writeFile(
    join(project.root, ".agmo", "config.json"),
    `${JSON.stringify({ cleanup: { cache_ttl_days: 0 } }, null, 2)}\n`,
    "utf8"
  );

  const freshPlan = await withHome(home, () => createAllProjectsCleanupPlan({ cwd: parent, nowMs }));
  assert.equal(freshPlan.options.older_than_days, null);
  assert.deepEqual(
    freshPlan.projects[0]?.would_delete.map((entry) => entry.relative_path),
    [".agmo/logs/old.log"]
  );

  const run = await runAllProjectsCleanupPlan(retainedPlan);
  assert.equal(run.projects[0]?.run_totals.removed_entries, 0);
  assert.equal(existsSync(project.logPath), true);
  assert.deepEqual(await fileSnapshot(project.logPath), beforeLog);
});

test("runAllProjectsCleanupPlan skips invalid projects during revalidation without local execution", async () => {
  const parent = await mkdtemp(join(os.tmpdir(), "agmo-all-projects-revalidate-"));
  const home = await mkdtemp(join(os.tmpdir(), "agmo-all-projects-revalidate-home-"));
  const rootRemoved = await createProject({ parent, name: "root-removed", ageDays: 10 });
  const agmoRemoved = await createProject({ parent, name: "agmo-removed", ageDays: 10 });
  const agmoFile = await createProject({ parent, name: "agmo-file", ageDays: 10 });
  const rootSymlink = await createProject({ parent, name: "root-symlink", ageDays: 10 });
  const agmoSymlink = await createProject({ parent, name: "agmo-symlink", ageDays: 10 });
  const ownershipInvalid = await createProject({ parent, name: "ownership-invalid", ageDays: 10 });
  await writeRegistry(home, [
    rootRemoved.root,
    agmoRemoved.root,
    agmoFile.root,
    rootSymlink.root,
    agmoSymlink.root,
    ownershipInvalid.root
  ]);
  const plan = await withHome(home, () =>
    createAllProjectsCleanupPlan({ cwd: parent, olderThanDays: 1, nowMs: Date.now() })
  );
  const symlinkTarget = join(parent, "symlink-target");
  const agmoTarget = join(parent, "agmo-target");

  await rm(rootRemoved.root, { recursive: true, force: true });
  await rm(join(agmoRemoved.root, ".agmo"), { recursive: true, force: true });
  await rm(join(agmoFile.root, ".agmo"), { recursive: true, force: true });
  await writeFile(join(agmoFile.root, ".agmo"), "not a directory\n", "utf8");
  await mkdir(symlinkTarget, { recursive: true });
  await rm(rootSymlink.root, { recursive: true, force: true });
  await symlink(symlinkTarget, rootSymlink.root);
  await mkdir(agmoTarget, { recursive: true });
  await rm(join(agmoSymlink.root, ".agmo"), { recursive: true, force: true });
  await symlink(agmoTarget, join(agmoSymlink.root, ".agmo"));
  await rm(join(ownershipInvalid.root, ".agmo", "config.json"), { force: true });

  const run = await runAllProjectsCleanupPlan(plan);

  assert.equal(run.projects.length, 0);
  assert.equal(run.totals.skipped_projects, 6);
  assert.deepEqual(
    run.skipped_projects.map((project) => project.reason).sort(),
    [
      ".agmo is a symlink",
      ".agmo is not a directory",
      "missing .agmo directory",
      "missing Agmo ownership evidence",
      "project root is a symlink",
      "project root missing"
    ].sort()
  );
  assert.equal(run.totals.removed_entries, 0);
});

test("runAllProjectsCleanupPlan skips retained-plan agmo realpath mismatch and outside entry tampering safely", async () => {
  const parent = await mkdtemp(join(os.tmpdir(), "agmo-all-projects-tamper-"));
  const home = await mkdtemp(join(os.tmpdir(), "agmo-all-projects-tamper-home-"));
  const first = await createProject({ parent, name: "project-level", ageDays: 10 });
  const second = await createProject({ parent, name: "entry-level", ageDays: 10 });
  const outside = join(parent, "outside.log");
  await writeFile(outside, "outside\n", "utf8");
  await writeRegistry(home, [first.root, second.root]);
  const plan = await withHome(home, () =>
    createAllProjectsCleanupPlan({ cwd: parent, olderThanDays: 1, nowMs: Date.now() })
  );
  const projectPlan = plan.projects.find((project) => project.project_root === first.realRoot);
  const entryPlan = plan.projects.find((project) => project.project_root === second.realRoot);
  assert.ok(projectPlan);
  assert.ok(entryPlan);
  projectPlan.agmo_dir = parent;
  entryPlan.would_delete[0] = {
    ...entryPlan.would_delete[0]!,
    path: outside
  };

  const run = await runAllProjectsCleanupPlan(plan);

  assert.equal(run.skipped_projects.length, 1);
  assert.equal(run.skipped_projects[0]?.reason, ".agmo realpath changed since planning");
  assert.equal(run.projects.length, 1);
  assert.deepEqual(
    run.projects[0]?.skipped.map((entry) => entry.skipped_reason),
    ["planned absolute path no longer matches planned category"]
  );
  assert.equal(run.totals.failure_entries, 0);
  assert.equal(existsSync(outside), true);
  assert.equal(existsSync(first.logPath), true);
});

test("runAllProjectsCleanup preserves local category parity, ordering, totals, and idempotency", async () => {
  const parent = await mkdtemp(join(os.tmpdir(), "agmo-all-projects-run-"));
  const home = await mkdtemp(join(os.tmpdir(), "agmo-all-projects-run-home-"));
  const second = await createProject({ parent, name: "b", ageDays: 10 });
  const first = await createProject({ parent, name: "a", ageDays: 10 });
  await mkdir(join(first.root, ".agmo", "memory"), { recursive: true });
  const memoryPath = join(first.root, ".agmo", "memory", "wisdom.json");
  await writeFile(memoryPath, "memory\n", "utf8");
  await writeRegistry(home, [second.root, first.root]);

  const firstRun = await withHome(home, () =>
    runAllProjectsCleanup({ cwd: parent, olderThanDays: 1, nowMs: Date.now() })
  );
  const secondRun = await withHome(home, () =>
    runAllProjectsCleanup({ cwd: parent, olderThanDays: 1, nowMs: Date.now() })
  );

  assert.deepEqual(
    firstRun.projects.map((project) => project.project_root),
    [first.realRoot, second.realRoot]
  );
  assert.equal(firstRun.totals.failure_entries, 0);
  assert.equal(typeof firstRun.projects[0]?.effective_caps.max_project_agmo_bytes.effective, "number");
  assert.equal(typeof firstRun.projects[0]?.pressure.project_bytes.target, "number");
  assert.equal("pressure" in firstRun, false);
  assert.equal(firstRun.totals.removed_entries, 2);
  assert.deepEqual(
    firstRun.projects.flatMap((project) => project.removed.map((entry) => entry.category)),
    ["logs", "logs"]
  );
  assert.equal(existsSync(first.logPath), false);
  assert.equal(existsSync(second.logPath), false);
  assert.equal(existsSync(memoryPath), true);
  assert.equal(secondRun.totals.removed_entries, 0);
  assert.equal(secondRun.totals.removed_bytes, 0);
  assert.equal(secondRun.totals.failure_entries, 0);
});

test("entry-level symlink replacement is a per-project skip and leaves ok semantics failure-free", async () => {
  const parent = await mkdtemp(join(os.tmpdir(), "agmo-all-projects-entry-symlink-"));
  const home = await mkdtemp(join(os.tmpdir(), "agmo-all-projects-entry-symlink-home-"));
  const project = await createProject({ parent, name: "project", ageDays: 10 });
  const outside = join(parent, "outside.log");
  await writeFile(outside, "outside\n", "utf8");
  await writeRegistry(home, [project.root]);
  const plan = await withHome(home, () =>
    createAllProjectsCleanupPlan({ cwd: parent, olderThanDays: 1, nowMs: Date.now() })
  );

  await unlink(project.logPath);
  await symlink(outside, project.logPath);
  const run = await runAllProjectsCleanupPlan(plan);

  assert.equal(run.skipped_projects.length, 0);
  assert.equal(run.projects[0]?.skipped[0]?.skipped_reason, "planned path is now a symlink");
  assert.equal(run.totals.failure_entries, 0);
  assert.equal(existsSync(outside), true);
});

test("runAllProjectsCleanupPlan inherits launch workspace delete-time guard skips", async () => {
  const parent = await mkdtemp(join(os.tmpdir(), "agmo-all-projects-launch-guard-"));
  const home = await mkdtemp(join(os.tmpdir(), "agmo-all-projects-launch-guard-home-"));
  const project = await createProject({ parent, name: "project" });
  const workspaceDir = join(project.root, ".agmo", "cache", "launch-workspaces", "session-1");
  const workspaceRoot = join(workspaceDir, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  execFileSync("git", ["init"], { cwd: workspaceRoot, stdio: "ignore" });
  await writeFile(
    join(workspaceDir, "metadata.json"),
    `${JSON.stringify(
      {
        session_id: "session-1",
        project_root: project.root,
        workspace_root: workspaceRoot,
        composed_agents_path: join(project.root, ".agmo", "cache", "session-instructions", "session-1", "AGENTS.md"),
        created_at: new Date(Date.now() - 10 * DAY_MS).toISOString(),
        active: false
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeRegistry(home, [project.root]);
  const plan = await withHome(home, () =>
    createAllProjectsCleanupPlan({ cwd: parent, olderThanDays: 1, nowMs: Date.now() })
  );
  assert.ok(
    plan.projects[0]?.would_delete.some(
      (entry) => entry.relative_path === ".agmo/cache/launch-workspaces/session-1"
    )
  );

  await writeFile(join(workspaceRoot, "dirty.txt"), "changed\n", "utf8");
  const run = await runAllProjectsCleanupPlan(plan);

  assert.deepEqual(run.projects[0]?.removed, []);
  assert.deepEqual(
    run.projects[0]?.skipped.map((entry) => ({
      relative_path: entry.relative_path,
      skipped_reason: entry.skipped_reason
    })),
    [
      {
        relative_path: ".agmo/cache/launch-workspaces/session-1",
        skipped_reason: "launch workspace dirty before deletion"
      }
    ]
  );
  assert.equal(existsSync(workspaceDir), true);
});

test("deletion failure marks ok semantics through failure_entries and later projects continue", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX directory permissions are required for this deletion failure fixture");
    return;
  }

  const parent = await mkdtemp(join(os.tmpdir(), "agmo-all-projects-failure-"));
  const home = await mkdtemp(join(os.tmpdir(), "agmo-all-projects-failure-home-"));
  const failing = await createProject({ parent, name: "a-failing", ageDays: 10 });
  const later = await createProject({ parent, name: "b-later", ageDays: 10 });
  await writeRegistry(home, [failing.root, later.root]);
  const plan = await withHome(home, () =>
    createAllProjectsCleanupPlan({ cwd: parent, olderThanDays: 1, nowMs: Date.now() })
  );

  await chmod(dirname(failing.logPath), 0o555);
  try {
    const run = await runAllProjectsCleanupPlan(plan);
    assert.equal(run.totals.failure_entries, 1);
    assert.equal(run.totals.removed_entries, 1);
    assert.equal(run.projects.find((project) => project.project_root === later.realRoot)?.removed.length, 1);
    assert.equal(existsSync(later.logPath), false);
  } finally {
    await chmod(dirname(failing.logPath), 0o755).catch(() => undefined);
  }
});
