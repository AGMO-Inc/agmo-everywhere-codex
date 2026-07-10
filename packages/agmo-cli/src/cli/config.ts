import {
  readScopedAgmoConfig,
  resolveCleanupPolicy,
  resolveLaunchPolicy,
  resolveSessionStartPolicy,
  resolveWikiContextPolicy,
  resolveVaultAutosavePolicy,
  resetCleanupPolicy,
  setCleanupPolicyValue,
  unsetCleanupPolicyValue,
  type AgmoCleanupPolicyKey
} from "../config/runtime.js";
import { parseScopeFlag } from "../utils/args.js";
import { resolveRuntimeRoot } from "../utils/paths.js";
import { resolveVaultRoot } from "../vault/runtime.js";
import { runLaunchCommand } from "./launch.js";
import { runSessionStartCommand } from "./session-start.js";
import { runVaultCommand } from "./vault.js";
import { runVaultAutosaveCommand } from "./vault-autosave.js";

function printConfigHelp(): void {
  console.log(`Usage:
  agmo config show [--scope user|project]
  agmo config vault <show|set-root> ...
  agmo config vault-autosave <show|set|unset|reset> ...
  agmo config cleanup <show|set|unset|reset> ...
  agmo config launch <show|set|unset|reset> ...
  agmo config session-start <show|set|unset|reset> ...

Examples:
  agmo config show
  agmo config show --scope project
  agmo config vault show
  agmo config vault set-root ~/my-vault --scope project
  agmo config vault-autosave show
  agmo config vault-autosave set update_mode append-section --scope project
  agmo config vault-autosave set min_interval_ms 15000 --scope project
  agmo config vault-autosave set append_max_entries 12 --scope project
  agmo config vault-autosave set workflow_type.execute impl --scope project
  agmo config cleanup show
  agmo config cleanup set max_project_agmo_bytes 1000000000 --scope project
  agmo config cleanup set safe_auto_cleanup_on_launch false --scope project
  agmo config launch show
  agmo config launch set autonomy_mode madmax --scope project
  agmo config launch set heartbeat_interval_ms 45000 --scope project
  agmo config session-start show
  agmo config session-start set mode compact --scope project
  agmo config session-start set mode debug --scope project
`);
}

const CLEANUP_POLICY_KEYS = new Set<AgmoCleanupPolicyKey>([
  "enabled",
  "dry_run_default",
  "state_ttl_days",
  "workflow_state_ttl_days",
  "session_instructions_ttl_days",
  "handoff_ttl_days",
  "launch_workspace_ttl_hours",
  "cache_ttl_days",
  "max_project_agmo_bytes",
  "max_launch_workspace_bytes",
  "max_state_files",
  "all_project_scan_max_depth",
  "safe_auto_cleanup_on_launch"
]);

function parseCleanupPolicyKey(raw: string | undefined, usage: string): AgmoCleanupPolicyKey {
  if (!raw || !CLEANUP_POLICY_KEYS.has(raw as AgmoCleanupPolicyKey)) {
    throw new Error(usage);
  }

  return raw as AgmoCleanupPolicyKey;
}

function parseCleanupPolicyValue(
  key: AgmoCleanupPolicyKey,
  raw: string | undefined
): boolean | number {
  if (raw === undefined) {
    throw new Error("missing value for cleanup policy");
  }

  if (
    key === "enabled" ||
    key === "dry_run_default" ||
    key === "safe_auto_cleanup_on_launch"
  ) {
    if (raw === "true") {
      return true;
    }
    if (raw === "false") {
      return false;
    }
    throw new Error(`${key} must be true or false`);
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw new Error(`${key} must be a non-negative integer`);
  }

  return parsed;
}

async function runCleanupConfigCommand(args: string[], projectRoot: string): Promise<void> {
  const action = args[0];
  const usage =
    "usage: agmo config cleanup <show|set|unset|reset> [key] [value] [--scope user|project]";

  if (action === "show") {
    const configArgs = args.slice(1);
    const scope =
      configArgs.includes("--scope") || configArgs.some((arg) => arg.startsWith("--scope="))
        ? parseScopeFlag(configArgs)
        : null;

    if (scope) {
      const scoped = await readScopedAgmoConfig(scope, projectRoot);
      console.log(
        JSON.stringify(
          {
            command: "config cleanup show",
            mode: "scoped",
            scope,
            config_path: scoped.config_path,
            cleanup: scoped.config.cleanup ?? {}
          },
          null,
          2
        )
      );
      return;
    }

    console.log(
      JSON.stringify(
        {
          command: "config cleanup show",
          mode: "effective",
          ...(await resolveCleanupPolicy(projectRoot))
        },
        null,
        2
      )
    );
    return;
  }

  if (action === "set") {
    const key = parseCleanupPolicyKey(args[1], usage);
    const value = parseCleanupPolicyValue(key, args[2]);
    const result = await setCleanupPolicyValue({
      key,
      value,
      scope: parseScopeFlag(args.slice(3)),
      cwd: projectRoot
    });
    console.log(JSON.stringify({ command: "config cleanup set", ...result }, null, 2));
    return;
  }

  if (action === "unset") {
    const key = parseCleanupPolicyKey(args[1], usage);
    const result = await unsetCleanupPolicyValue({
      key,
      scope: parseScopeFlag(args.slice(2)),
      cwd: projectRoot
    });
    console.log(JSON.stringify({ command: "config cleanup unset", ...result }, null, 2));
    return;
  }

  if (action === "reset") {
    const result = await resetCleanupPolicy({
      scope: parseScopeFlag(args.slice(1)),
      cwd: projectRoot
    });
    console.log(JSON.stringify({ command: "config cleanup reset", ...result }, null, 2));
    return;
  }

  throw new Error(usage);
}

export async function runConfigCommand(args: string[]): Promise<void> {
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    printConfigHelp();
    return;
  }

  const projectRoot = resolveRuntimeRoot();
  const subcommand = args[0];

  if (subcommand === "show") {
    const showArgs = args.slice(1);
    const scope =
      showArgs.includes("--scope") || showArgs.some((arg) => arg.startsWith("--scope="))
        ? parseScopeFlag(showArgs)
        : null;

    if (scope) {
      const scoped = await readScopedAgmoConfig(scope, projectRoot);
      console.log(
        JSON.stringify(
          {
            command: "config show",
            mode: "scoped",
            scope,
            config_path: scoped.config_path,
            config: scoped.config
          },
          null,
          2
        )
      );
      return;
    }

    const launch = await resolveLaunchPolicy(projectRoot);
    const sessionStart = await resolveSessionStartPolicy(projectRoot);
    const wiki = await resolveWikiContextPolicy(projectRoot);
    const cleanup = await resolveCleanupPolicy(projectRoot);
    const vaultAutosave = await resolveVaultAutosavePolicy(projectRoot);
    const vault = await resolveVaultRoot(projectRoot);
    console.log(
      JSON.stringify(
        {
          command: "config show",
          mode: "effective",
          vault,
          launch,
          session_start: sessionStart,
          wiki,
          cleanup,
          vault_autosave: vaultAutosave
        },
        null,
        2
      )
    );
    return;
  }

  if (subcommand === "vault") {
    await runVaultCommand(["config", ...args.slice(1)]);
    return;
  }

  if (subcommand === "vault-autosave") {
    await runVaultAutosaveCommand(args.slice(1));
    return;
  }

  if (subcommand === "cleanup") {
    await runCleanupConfigCommand(args.slice(1), projectRoot);
    return;
  }

  if (subcommand === "launch") {
    await runLaunchCommand(["config", ...args.slice(1)]);
    return;
  }

  if (subcommand === "session-start") {
    await runSessionStartCommand(["config", ...args.slice(1)]);
    return;
  }

  throw new Error(
    "usage: agmo config <show [--scope user|project]|vault <show|set-root> ...|vault-autosave <show|set|unset|reset> ...|cleanup <show|set|unset|reset> ...|launch <show|set|unset|reset> ...|session-start <show|set|unset|reset> ...>"
  );
}
