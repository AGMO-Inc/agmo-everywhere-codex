import type { InstallScope } from "../utils/paths.js";
import { resolveRuntimeRoot } from "../utils/paths.js";
import {
  DEFAULT_FULL_BUDGET_CHARS,
  DEFAULT_MANIFEST_BUDGET_CHARS,
  renderWikiContext,
  type WikiContextFormat,
  type WikiContextMode
} from "../wiki/context.js";
import { auditWiki, renderWikiMaintenanceMarkdown } from "../wiki/maintain.js";
import { migrateWisdomToWiki, renderWisdomMigrationMarkdown } from "../wiki/migrate.js";
import { parsePositiveInteger, resolveWikiRuntime } from "../wiki/runtime.js";

function printWikiHelp(): void {
  console.log(`Usage:
  agmo wiki context --project <name> [--budget n] [--format markdown|json] [--manifest|--full]
  agmo wiki maintain --project <name> [--max-age-days n] [--format markdown|json]
  agmo wiki migrate-wisdom [--scope user|project] [--project <name>] [--dry-run]

Examples:
  agmo wiki context --project agmo-everywhere-codex --manifest
  agmo wiki context --project agmo-everywhere-codex --full --budget 9000 --format json
  agmo wiki maintain --project agmo-everywhere-codex --format json
  agmo wiki migrate-wisdom --scope project --project agmo-everywhere-codex --dry-run
`);
}

function readFlag(args: string[], name: string): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) {
      return args[index + 1] ?? null;
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return null;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function parseFormat(args: string[]): WikiContextFormat {
  const raw = readFlag(args, "--format") ?? "markdown";
  if (raw === "markdown" || raw === "json") {
    return raw;
  }
  throw new Error("--format must be markdown|json");
}

function parseScope(args: string[]): InstallScope {
  const raw = readFlag(args, "--scope") ?? "project";
  if (raw === "user" || raw === "project") {
    return raw;
  }
  throw new Error("--scope must be user|project");
}

function parseRequiredBudget(args: string[], fallback: number): number {
  const raw = readFlag(args, "--budget");
  if (raw === null) {
    return fallback;
  }
  const parsed = parsePositiveInteger(raw);
  if (parsed === null) {
    throw new Error("--budget must be a positive integer");
  }
  return parsed;
}

function parseMaxAgeDays(args: string[]): number {
  const raw = readFlag(args, "--max-age-days");
  if (raw === null) {
    return 90;
  }
  const parsed = parsePositiveInteger(raw);
  if (parsed === null) {
    throw new Error("--max-age-days must be a positive integer");
  }
  return parsed;
}

function parseContextMode(args: string[]): Exclude<WikiContextMode, "off"> {
  const manifest = hasFlag(args, "--manifest");
  const full = hasFlag(args, "--full");
  if (manifest && full) {
    throw new Error("Use only one of --manifest or --full");
  }
  return full ? "full" : "manifest";
}

export async function runWikiCommand(args: string[]): Promise<void> {
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help" || args.length === 0) {
    printWikiHelp();
    return;
  }

  const cwd = resolveRuntimeRoot();
  const action = args[0];
  const rest = args.slice(1);

  if (action === "context") {
    const project = readFlag(rest, "--project");
    if (!project) {
      throw new Error("usage: agmo wiki context --project <name> [--budget n] [--format markdown|json] [--manifest|--full]");
    }
    const mode = parseContextMode(rest);
    const runtime = await resolveWikiRuntime({ cwd, project, requireVault: true });
    if (!runtime) {
      throw new Error("Vault not configured.");
    }
    const budget = parseRequiredBudget(
      rest,
      mode === "manifest" ? DEFAULT_MANIFEST_BUDGET_CHARS : DEFAULT_FULL_BUDGET_CHARS
    );
    process.stdout.write(
      await renderWikiContext({
        runtime,
        mode,
        format: parseFormat(rest),
        budgetChars: budget,
        includeHealth: process.env.AGMO_MANIFEST_HEALTH === "1"
      })
    );
    return;
  }

  if (action === "maintain") {
    const project = readFlag(rest, "--project");
    if (!project) {
      throw new Error("usage: agmo wiki maintain --project <name> [--max-age-days n] [--format markdown|json]");
    }
    const runtime = await resolveWikiRuntime({ cwd, project, requireVault: true });
    if (!runtime) {
      throw new Error("Vault not configured.");
    }
    const result = await auditWiki({ runtime, maxAgeDays: parseMaxAgeDays(rest) });
    if (parseFormat(rest) === "json") {
      console.log(JSON.stringify(result, null, 2));
    } else {
      process.stdout.write(renderWikiMaintenanceMarkdown(result));
    }
    return;
  }

  if (action === "migrate-wisdom") {
    const scope = parseScope(rest);
    const project = readFlag(rest, "--project") ?? undefined;
    const runtime = await resolveWikiRuntime({ cwd, project, requireVault: true });
    if (!runtime) {
      throw new Error("Vault not configured.");
    }
    const result = await migrateWisdomToWiki({
      runtime,
      scope,
      dryRun: hasFlag(rest, "--dry-run")
    });
    if (parseFormat(rest) === "json") {
      console.log(JSON.stringify(result, null, 2));
    } else {
      process.stdout.write(renderWisdomMigrationMarkdown(result));
    }
    return;
  }

  throw new Error(
    "usage: agmo wiki <context|maintain|migrate-wisdom> ..."
  );
}
