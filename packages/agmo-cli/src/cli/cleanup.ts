import {
  createAllProjectsCleanupPlan,
  runAllProjectsCleanup
} from "../cleanup/all-projects.js";
import { collectCleanupInventory } from "../cleanup/inventory.js";
import { createCleanupPlan } from "../cleanup/plan.js";
import {
  discoverCleanupProjects,
  inspectAllCleanupProjects,
  listCleanupProjects
} from "../cleanup/projects.js";
import { runCleanup } from "../cleanup/run.js";
import { machineJsonEnvelope } from "../utils/machine-json.js";
import { resolveRuntimeRoot } from "../utils/paths.js";

function printCleanupHelp(): void {
  console.log(`Agmo Cleanup

Usage:
  agmo cleanup inspect [--json] [--verbose]
  agmo cleanup inspect --all-projects [--json] [--verbose]
  agmo cleanup projects [--json]
  agmo cleanup projects discover --root <path> [--json] [--max-depth <n>]
  agmo cleanup plan [--all-projects] [--json] [--verbose] [--older-than-days <n>] [--max-bytes <n>]
  agmo cleanup run [--all-projects] --confirm [--json] [--older-than-days <n>] [--max-bytes <n>]

Cleanup inspect and plan are non-mutating. Cleanup run requires --confirm.
`);
}

function parseNonNegativeInteger(value: string | undefined, flag: string): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error(`${flag} must be a non-negative integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${flag} must be a safe non-negative integer`);
  }

  return parsed;
}

function parsePlanArgs(args: string[]): {
  json: boolean;
  verbose: boolean;
  allProjects: boolean;
  olderThanDays?: number;
  maxBytes?: number;
} {
  const parsed: {
    json: boolean;
    verbose: boolean;
    allProjects: boolean;
    olderThanDays?: number;
    maxBytes?: number;
  } = {
    json: false,
    verbose: false,
    allProjects: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--all-projects") {
      parsed.allProjects = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--verbose") {
      parsed.verbose = true;
      continue;
    }
    if (arg === "--older-than-days") {
      parsed.olderThanDays = parseNonNegativeInteger(args[index + 1], "--older-than-days");
      index += 1;
      continue;
    }
    if (arg === "--max-bytes") {
      parsed.maxBytes = parseNonNegativeInteger(args[index + 1], "--max-bytes");
      index += 1;
      continue;
    }
    throw new Error(
      "usage: agmo cleanup plan [--all-projects] [--json] [--verbose] [--older-than-days <n>] [--max-bytes <n>]"
    );
  }

  return parsed;
}

function parseRunArgs(args: string[]): {
  json: boolean;
  confirm: boolean;
  allProjects: boolean;
  olderThanDays?: number;
  maxBytes?: number;
} {
  const parsed: {
    json: boolean;
    confirm: boolean;
    allProjects: boolean;
    olderThanDays?: number;
    maxBytes?: number;
  } = {
    json: false,
    confirm: false,
    allProjects: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--all-projects") {
      parsed.allProjects = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--confirm") {
      parsed.confirm = true;
      continue;
    }
    if (arg === "--older-than-days") {
      parsed.olderThanDays = parseNonNegativeInteger(args[index + 1], "--older-than-days");
      index += 1;
      continue;
    }
    if (arg === "--max-bytes") {
      parsed.maxBytes = parseNonNegativeInteger(args[index + 1], "--max-bytes");
      index += 1;
      continue;
    }
    throw new Error(
      "usage: agmo cleanup run [--all-projects] --confirm [--json] [--older-than-days <n>] [--max-bytes <n>]"
    );
  }

  if (!parsed.confirm) {
    throw new Error("cleanup run requires --confirm");
  }

  return parsed;
}

function parseProjectsDiscoverArgs(args: string[]): {
  json: boolean;
  root?: string;
  maxDepth?: number;
} {
  const parsed: { json: boolean; root?: string; maxDepth?: number } = {
    json: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--root") {
      parsed.root = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--max-depth") {
      parsed.maxDepth = parseNonNegativeInteger(args[index + 1], "--max-depth");
      index += 1;
      continue;
    }
    throw new Error("usage: agmo cleanup projects discover --root <path> [--json] [--max-depth <n>]");
  }

  if (!parsed.root) {
    throw new Error("cleanup projects discover requires --root <path>");
  }

  return parsed;
}

async function runCleanupProjectsCommand(args: string[], projectRoot: string): Promise<void> {
  const action = args[0];
  if (action === undefined || action === "--json") {
    if (args.length > 1) {
      throw new Error("usage: agmo cleanup projects [--json]");
    }
    const projects = await listCleanupProjects(projectRoot);
    console.log(
      JSON.stringify(
        machineJsonEnvelope("cleanup.projects", true, {
          command: "cleanup projects",
          registry_path: projects.registry_path,
          projects: projects.projects
        }),
        null,
        2
      )
    );
    return;
  }

  if (action === "discover") {
    const parsed = parseProjectsDiscoverArgs(args.slice(1));
    const root = parsed.root;
    if (!root) {
      throw new Error("cleanup projects discover requires --root <path>");
    }
    const result = await discoverCleanupProjects({
      root,
      maxDepth: parsed.maxDepth ?? 5,
      cwd: projectRoot
    });
    console.log(
      JSON.stringify(
        machineJsonEnvelope("cleanup.projects.discover", true, {
          command: "cleanup projects discover",
          registry_path: result.registry_path,
          root: result.root,
          max_depth: result.max_depth,
          discovered: result.discovered,
          skipped: result.skipped,
          registry: result.registry
        }),
        null,
        2
      )
    );
    return;
  }

  throw new Error("usage: agmo cleanup projects [--json] | projects discover --root <path> [--json] [--max-depth <n>]");
}

export async function runCleanupCommand(args: string[]): Promise<void> {
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    printCleanupHelp();
    return;
  }

  const subcommand = args[0] ?? "inspect";
  if (subcommand !== "inspect" && subcommand !== "projects" && subcommand !== "plan" && subcommand !== "run") {
    throw new Error(
      "usage: agmo cleanup <inspect|projects|plan|run> [--json] [--verbose] [--older-than-days <n>] [--max-bytes <n>]"
    );
  }

  const projectRoot = resolveRuntimeRoot();
  if (subcommand === "projects") {
    await runCleanupProjectsCommand(args.slice(1), projectRoot);
    return;
  }

  if (subcommand === "run") {
    const runArgs = parseRunArgs(args.slice(1));
    if (runArgs.allProjects) {
      const result = await runAllProjectsCleanup({
        cwd: projectRoot,
        olderThanDays: runArgs.olderThanDays,
        maxBytes: runArgs.maxBytes
      });

      console.log(
        JSON.stringify(
          machineJsonEnvelope("cleanup.run.all-projects", result.totals.failure_entries === 0, {
            command: "cleanup run --all-projects",
            registry_path: result.registry_path,
            options: result.options,
            totals: result.totals,
            projects: result.projects,
            skipped_projects: result.skipped_projects
          }),
          null,
          2
        )
      );
      return;
    }

    const result = await runCleanup(projectRoot, {
      olderThanDays: runArgs.olderThanDays,
      maxBytes: runArgs.maxBytes
    });

    console.log(
      JSON.stringify(
        machineJsonEnvelope("cleanup.run", result.run.failures.length === 0, {
          command: "cleanup run",
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
        }),
        null,
        2
      )
    );
    return;
  }

  if (subcommand === "plan") {
    const planArgs = parsePlanArgs(args.slice(1));
    if (planArgs.allProjects) {
      const result = await createAllProjectsCleanupPlan({
        cwd: projectRoot,
        olderThanDays: planArgs.olderThanDays,
        maxBytes: planArgs.maxBytes
      });

      console.log(
        JSON.stringify(
          machineJsonEnvelope("cleanup.plan.all-projects", true, {
            command: "cleanup plan --all-projects",
            registry_path: result.registry_path,
            options: result.options,
            totals: result.totals,
            projects: result.projects,
            skipped_projects: result.skipped_projects
          }),
          null,
          2
        )
      );
      return;
    }

    const plan = await createCleanupPlan(projectRoot, {
      olderThanDays: planArgs.olderThanDays,
      maxBytes: planArgs.maxBytes
    });

    console.log(
      JSON.stringify(
        machineJsonEnvelope("cleanup.plan", true, {
          command: "cleanup plan",
          project_root: plan.project_root,
          agmo_dir: plan.agmo_dir,
          policy: plan.policy,
          options: plan.options,
          effective_caps: plan.effective_caps,
          pressure: plan.pressure,
          totals: plan.totals,
          would_delete: plan.would_delete,
          kept: plan.kept
        }),
        null,
        2
      )
    );
    return;
  }

  const inspectArgs = args.slice(1);
  const inspectAllowed = new Set(["--all-projects", "--json", "--verbose"]);
  const unknownInspectArg = inspectArgs.find((arg) => !inspectAllowed.has(arg));
  if (unknownInspectArg) {
    throw new Error("usage: agmo cleanup inspect [--json] [--verbose] [--all-projects]");
  }
  const verbose = args.includes("--verbose");
  if (args.includes("--all-projects")) {
    const result = await inspectAllCleanupProjects({ cwd: projectRoot, verbose });
    console.log(
      JSON.stringify(
        machineJsonEnvelope("cleanup.inspect.all-projects", true, {
          command: "cleanup inspect --all-projects",
          registry_path: result.registry_path,
          totals: result.totals,
          categories: result.categories,
          projects: result.projects,
          skipped: result.skipped
        }),
        null,
        2
      )
    );
    return;
  }

  const inventory = await collectCleanupInventory(projectRoot);
  const entries = verbose
    ? inventory.entries
    : inventory.entries.map((entry) => ({
        category: entry.category,
        relative_path: entry.relative_path,
        bytes: entry.bytes,
        kind: entry.kind,
        ownership: entry.ownership,
        cleanup_eligible: entry.cleanup_eligible,
        keep_reason: entry.keep_reason,
        ...(entry.details ? { details: entry.details } : {})
      }));

  console.log(
    JSON.stringify(
      machineJsonEnvelope("cleanup.inspect", true, {
        command: "cleanup inspect",
        project_root: inventory.project_root,
        agmo_dir: inventory.agmo_dir,
        policy: inventory.policy,
        totals: inventory.totals,
        categories: inventory.categories,
        entries
      }),
      null,
      2
    )
  );
}
