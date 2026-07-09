import { collectCleanupInventory } from "../cleanup/inventory.js";
import { createCleanupPlan } from "../cleanup/plan.js";
import { runCleanup } from "../cleanup/run.js";
import { machineJsonEnvelope } from "../utils/machine-json.js";
import { resolveRuntimeRoot } from "../utils/paths.js";

function printCleanupHelp(): void {
  console.log(`Agmo Cleanup

Usage:
  agmo cleanup inspect [--json] [--verbose]
  agmo cleanup plan [--json] [--verbose] [--older-than-days <n>] [--max-bytes <n>]
  agmo cleanup run --confirm [--json] [--older-than-days <n>] [--max-bytes <n>]

Cleanup inspect and plan are non-mutating. Cleanup run is project-local and requires --confirm.
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
  olderThanDays?: number;
  maxBytes?: number;
} {
  const parsed: { json: boolean; verbose: boolean; olderThanDays?: number; maxBytes?: number } = {
    json: false,
    verbose: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
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
      "usage: agmo cleanup plan [--json] [--verbose] [--older-than-days <n>] [--max-bytes <n>]"
    );
  }

  return parsed;
}

function parseRunArgs(args: string[]): {
  json: boolean;
  confirm: boolean;
  olderThanDays?: number;
  maxBytes?: number;
} {
  const parsed: { json: boolean; confirm: boolean; olderThanDays?: number; maxBytes?: number } = {
    json: false,
    confirm: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
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
      "usage: agmo cleanup run --confirm [--json] [--older-than-days <n>] [--max-bytes <n>]"
    );
  }

  if (!parsed.confirm) {
    throw new Error("cleanup run requires --confirm");
  }

  return parsed;
}

export async function runCleanupCommand(args: string[]): Promise<void> {
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    printCleanupHelp();
    return;
  }

  const subcommand = args[0] ?? "inspect";
  if (subcommand !== "inspect" && subcommand !== "plan" && subcommand !== "run") {
    throw new Error(
      "usage: agmo cleanup <inspect|plan|run> [--json] [--verbose] [--older-than-days <n>] [--max-bytes <n>]"
    );
  }

  const projectRoot = resolveRuntimeRoot();
  if (subcommand === "run") {
    const runArgs = parseRunArgs(args.slice(1));
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
  const inspectAllowed = new Set(["--json", "--verbose"]);
  const unknownInspectArg = inspectArgs.find((arg) => !inspectAllowed.has(arg));
  if (unknownInspectArg) {
    throw new Error("usage: agmo cleanup inspect [--json] [--verbose]");
  }
  const verbose = args.includes("--verbose");
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
