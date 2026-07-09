import { collectCleanupInventory } from "../cleanup/inventory.js";
import { machineJsonEnvelope } from "../utils/machine-json.js";
import { resolveRuntimeRoot } from "../utils/paths.js";

function printCleanupHelp(): void {
  console.log(`Agmo Cleanup

Usage:
  agmo cleanup inspect [--json] [--verbose]

Slice 1 is inspect-only. It never deletes files.
`);
}

export async function runCleanupCommand(args: string[]): Promise<void> {
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    printCleanupHelp();
    return;
  }

  const subcommand = args[0] ?? "inspect";
  if (subcommand !== "inspect") {
    throw new Error("usage: agmo cleanup inspect [--json] [--verbose]");
  }

  const projectRoot = resolveRuntimeRoot();
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
