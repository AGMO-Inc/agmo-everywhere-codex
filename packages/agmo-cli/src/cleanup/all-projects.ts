import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { createCleanupPlan, type CleanupPlanOptions, type CleanupPlanSummary } from "./plan.js";
import {
  listCleanupProjects,
  validateCleanupProjectRoot
} from "./projects.js";
import { runCleanupPlan, type CleanupRunSummary } from "./run.js";

export type AllProjectsCleanupOptions = CleanupPlanOptions & {
  cwd?: string;
};

export type AllProjectsCleanupSkippedProject = {
  project_root: string;
  agmo_dir: string;
  reason: string;
};

export type AllProjectsCleanupPlan = {
  registry_path: string;
  options: {
    older_than_days: number | null;
    max_bytes: number | null;
  };
  totals: {
    projects: number;
    skipped_projects: number;
    inspected_entries: number;
    inspected_bytes: number;
    would_delete_entries: number;
    would_delete_bytes: number;
    kept_entries: number;
    kept_bytes: number;
    projected_bytes_after_delete: number;
  };
  projects: CleanupPlanSummary[];
  skipped_projects: AllProjectsCleanupSkippedProject[];
};

export type AllProjectsCleanupRunProject = CleanupPlanSummary & {
  removed: CleanupRunSummary["run"]["removed"];
  skipped: CleanupRunSummary["run"]["skipped"];
  failures: CleanupRunSummary["run"]["failures"];
  run_totals: CleanupRunSummary["run"]["totals"];
};

export type AllProjectsCleanupRunSummary = Omit<AllProjectsCleanupPlan, "totals" | "projects"> & {
  totals: AllProjectsCleanupPlan["totals"] & {
    removed_entries: number;
    removed_bytes: number;
    skipped_entries: number;
    failure_entries: number;
  };
  projects: AllProjectsCleanupRunProject[];
};

function sortSkippedProjects(
  skippedProjects: AllProjectsCleanupSkippedProject[]
): AllProjectsCleanupSkippedProject[] {
  return skippedProjects.sort((left, right) => left.project_root.localeCompare(right.project_root));
}

function planOptions(options: CleanupPlanOptions): {
  older_than_days: number | null;
  max_bytes: number | null;
} {
  return {
    older_than_days: options.olderThanDays ?? null,
    max_bytes: options.maxBytes ?? null
  };
}

function planTotals(projects: CleanupPlanSummary[]): AllProjectsCleanupPlan["totals"] {
  return {
    projects: projects.length,
    skipped_projects: 0,
    inspected_entries: projects.reduce((sum, project) => sum + project.totals.inspected_entries, 0),
    inspected_bytes: projects.reduce((sum, project) => sum + project.totals.inspected_bytes, 0),
    would_delete_entries: projects.reduce((sum, project) => sum + project.totals.would_delete_entries, 0),
    would_delete_bytes: projects.reduce((sum, project) => sum + project.totals.would_delete_bytes, 0),
    kept_entries: projects.reduce((sum, project) => sum + project.totals.kept_entries, 0),
    kept_bytes: projects.reduce((sum, project) => sum + project.totals.kept_bytes, 0),
    projected_bytes_after_delete: projects.reduce(
      (sum, project) => sum + project.totals.projected_bytes_after_delete,
      0
    )
  };
}

function finalizePlanTotals(
  projects: CleanupPlanSummary[],
  skippedProjects: AllProjectsCleanupSkippedProject[]
): AllProjectsCleanupPlan["totals"] {
  return {
    ...planTotals(projects),
    skipped_projects: skippedProjects.length
  };
}

function runTotals(
  projects: AllProjectsCleanupRunProject[],
  skippedProjects: AllProjectsCleanupSkippedProject[]
): AllProjectsCleanupRunSummary["totals"] {
  return {
    ...finalizePlanTotals(projects, skippedProjects),
    removed_entries: projects.reduce((sum, project) => sum + project.run_totals.removed_entries, 0),
    removed_bytes: projects.reduce((sum, project) => sum + project.run_totals.removed_bytes, 0),
    skipped_entries: projects.reduce((sum, project) => sum + project.run_totals.skipped_entries, 0),
    failure_entries: projects.reduce((sum, project) => sum + project.run_totals.failure_entries, 0)
  };
}

function skippedProject(
  projectRoot: string,
  agmoDir: string,
  reason: string
): AllProjectsCleanupSkippedProject {
  return {
    project_root: projectRoot,
    agmo_dir: agmoDir,
    reason
  };
}

function errorReason(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
}

function flattenRunProject(result: CleanupRunSummary): AllProjectsCleanupRunProject {
  return {
    project_root: result.project_root,
    agmo_dir: result.agmo_dir,
    policy: result.policy,
    options: result.options,
    effective_caps: result.effective_caps,
    pressure: result.pressure,
    totals: result.totals,
    would_delete: result.would_delete,
    kept: result.kept,
    removed: result.run.removed,
    skipped: result.run.skipped,
    failures: result.run.failures,
    run_totals: result.run.totals
  };
}

async function retainedAgmoRealpath(plan: CleanupPlanSummary): Promise<
  | { ok: true; real_agmo_dir: string }
  | { ok: false; reason: string }
> {
  try {
    return { ok: true, real_agmo_dir: await realpath(plan.agmo_dir) };
  } catch (error) {
    return { ok: false, reason: `.agmo realpath failed: ${errorReason(error)}` };
  }
}

export async function createAllProjectsCleanupPlan(
  args: AllProjectsCleanupOptions = {}
): Promise<AllProjectsCleanupPlan> {
  const cwd = args.cwd ?? process.cwd();
  const sharedOptions: CleanupPlanOptions = {
    olderThanDays: args.olderThanDays,
    maxBytes: args.maxBytes,
    nowMs: args.nowMs ?? Date.now()
  };
  const registry = await listCleanupProjects(cwd);
  const projects: CleanupPlanSummary[] = [];
  const skippedProjects: AllProjectsCleanupSkippedProject[] = [];

  for (const project of registry.projects) {
    if (project.status !== "available") {
      skippedProjects.push(
        skippedProject(
          resolve(project.project_root),
          resolve(project.agmo_dir),
          project.skip_reason ?? "project unavailable"
        )
      );
      continue;
    }

    try {
      projects.push(await createCleanupPlan(project.project_root, sharedOptions));
    } catch (error) {
      skippedProjects.push(skippedProject(project.project_root, project.agmo_dir, errorReason(error)));
    }
  }

  projects.sort((left, right) => left.project_root.localeCompare(right.project_root));
  sortSkippedProjects(skippedProjects);

  return {
    registry_path: registry.registry_path,
    options: planOptions(sharedOptions),
    totals: finalizePlanTotals(projects, skippedProjects),
    projects,
    skipped_projects: skippedProjects
  };
}

export async function runAllProjectsCleanup(
  args: AllProjectsCleanupOptions = {}
): Promise<AllProjectsCleanupRunSummary> {
  const plan = await createAllProjectsCleanupPlan(args);
  return runAllProjectsCleanupPlan(plan);
}

export async function runAllProjectsCleanupPlan(
  plan: AllProjectsCleanupPlan
): Promise<AllProjectsCleanupRunSummary> {
  const runProjects: AllProjectsCleanupRunProject[] = [];
  const skippedProjects = [...plan.skipped_projects];

  for (const projectPlan of [...plan.projects].sort((left, right) => left.project_root.localeCompare(right.project_root))) {
    const validated = await validateCleanupProjectRoot(projectPlan.project_root);
    if (!validated.ok) {
      skippedProjects.push(
        skippedProject(validated.project_root, validated.agmo_dir, validated.reason)
      );
      continue;
    }

    const retainedRealpath = await retainedAgmoRealpath(projectPlan);
    if (!retainedRealpath.ok) {
      skippedProjects.push(
        skippedProject(projectPlan.project_root, projectPlan.agmo_dir, retainedRealpath.reason)
      );
      continue;
    }

    if (retainedRealpath.real_agmo_dir !== projectPlan.agmo_dir || validated.agmo_dir !== projectPlan.agmo_dir) {
      skippedProjects.push(
        skippedProject(
          projectPlan.project_root,
          projectPlan.agmo_dir,
          ".agmo realpath changed since planning"
        )
      );
      continue;
    }

    runProjects.push(flattenRunProject(await runCleanupPlan(projectPlan)));
  }

  runProjects.sort((left, right) => left.project_root.localeCompare(right.project_root));
  sortSkippedProjects(skippedProjects);

  return {
    registry_path: plan.registry_path,
    options: plan.options,
    totals: runTotals(runProjects, skippedProjects),
    projects: runProjects,
    skipped_projects: skippedProjects
  };
}
