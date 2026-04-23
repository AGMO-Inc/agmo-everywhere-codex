import {
  readScopedAgmoConfig,
  resolveLaunchPolicy,
  resolveSessionStartPolicy,
  resolveVaultAutosavePolicy
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
  agmo config launch show
  agmo config launch set heartbeat_interval_ms 45000 --scope project
  agmo config session-start show
  agmo config session-start set mode compact --scope project
  agmo config session-start set mode debug --scope project
`);
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

  if (subcommand === "launch") {
    await runLaunchCommand(["config", ...args.slice(1)]);
    return;
  }

  if (subcommand === "session-start") {
    await runSessionStartCommand(["config", ...args.slice(1)]);
    return;
  }

  throw new Error(
    "usage: agmo config <show [--scope user|project]|vault <show|set-root> ...|vault-autosave <show|set|unset|reset> ...|launch <show|set|unset|reset> ...|session-start <show|set|unset|reset> ...>"
  );
}
