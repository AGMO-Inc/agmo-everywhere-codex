#!/usr/bin/env node

import { runAgentsCommand } from "./agents.js";
import { runConfigCommand } from "./config.js";
import { runDoctorCommand } from "./doctor.js";
import { runHooksCommand } from "./hooks.js";
import { runInternalCommand } from "./internal.js";
import { runLaunchCommand } from "./launch.js";
import { runSessionStartCommand } from "./session-start.js";
import { runSetupCommand } from "./setup.js";
import { runTeamCommand } from "./team.js";
import { runVaultCommand } from "./vault.js";
import { runWisdomCommand } from "./wisdom.js";

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  switch (command) {
    case "setup":
      await runSetupCommand(args.slice(1));
      return;
    case "doctor":
      await runDoctorCommand(args.slice(1));
      return;
    case "config":
      await runConfigCommand(args.slice(1));
      return;
    case "launch":
      await runLaunchCommand(args.slice(1));
      return;
    case "session-start":
      await runSessionStartCommand(args.slice(1));
      return;
    case "agents":
      await runAgentsCommand(args.slice(1));
      return;
    case "hooks":
      await runHooksCommand(args.slice(1));
      return;
    case "internal":
      await runInternalCommand(args.slice(1));
      return;
    case "team":
      await runTeamCommand(args.slice(1));
      return;
    case "vault":
      await runVaultCommand(args.slice(1));
      return;
    case "wisdom":
      await runWisdomCommand(args.slice(1));
      return;
    case undefined:
    case "--help":
    case "-h":
    case "help":
      printHelp();
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

function formatCliError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
}

function printHelp(): void {
  console.log(`Agmo CLI

Usage:
  agmo setup [--scope user|project] [--force]
  agmo setup migrate-legacy [--scope user|project] [--delete]
  agmo doctor
  agmo config show [--scope user|project]
  agmo config vault <show|set-root> ...
  agmo config vault-autosave <show|set|unset|reset> ...
  agmo config launch <show|set|unset|reset> ...
  agmo config session-start <show|set|unset|reset> ...
  agmo launch [codex args...]
  agmo launch config show [--scope user|project]
  agmo launch config set <key> <value> [--scope user|project]
  agmo launch config unset <key> [--scope user|project]
  agmo launch config reset [--scope user|project]
  agmo session-start config show [--scope user|project]
  agmo session-start config set <key> <value> [--scope user|project]
  agmo session-start config unset <key> [--scope user|project]
  agmo session-start config reset [--scope user|project]
  agmo launch list [--summary|--verbose]
  agmo launch cleanup [--all] [--older-than-hours <n>] [--include-active] [--stale]
  agmo agents sync
  agmo hooks sync
  agmo internal hook
  agmo team start <workers> "<task>" [--allocation-intent <intent>] [--role-map worker-1=role,...] [--hud] [--hud-refresh-ms <ms>]
  agmo team status <team-name>
  agmo team shutdown <team-name>
  agmo team cleanup-stale [--stale-ms <ms>] [--dead-ms <ms>] [--include-stale|--no-include-stale] [--dry-run|--no-dry-run]
  agmo team claim <team> <task-id> <worker> [--ignore-dependencies]
  agmo team heartbeat <team> <worker>
  agmo team report <team> <worker> <state>
  agmo team monitor <team> [--preset observe|conservative|balanced|aggressive] [--auto-nudge] [--auto-reclaim] [--escalate-leader] [--leader-view]
  agmo team alert-delivery show <team>
  agmo team alert-delivery set <team> [--mailbox|--no-mailbox] [--slack|--no-slack] [--slack-webhook-url <url>] [--email|--no-email] [--email-to <a,b>]
  agmo team hud <team> [--watch] [--refresh-ms <ms>]
  agmo team dispatch-ack <team> <request-id>
  agmo team dispatch-retry <team> [worker]
  agmo team reclaim <team> [--reassign]
  agmo team rebalance <team> [--strict-role-match]
  agmo team integrate <team> [--strategy cherry-pick|squash] [--max-commits <n>] [--batch-size <n>] [--batch-order oldest|newest|task-id] [--target-ref <ref|@base|@current>] [--checkout-target] [--on-conflict continue|stop] [--on-empty skip|fail] [--dry-run]
  agmo team integrate-assist <team>
  agmo wisdom show [--scope user|project]
  agmo wisdom add <learn|decision|issue> <content> [--scope user|project]
  agmo wisdom reset [--scope user|project]
  agmo vault config show
  agmo vault config set-root <path> [--scope user|project]
  agmo vault scaffold --type <type> --project <project> --title <title> [--schema <name>] [--template-file <path>]
  agmo vault create --type <type> --project <project> --title <title> [--schema <name>] [--template-file <path>] [--index]
  agmo vault save --type <type> --project <project> --title <title> --file <path> [--index]
`);
}

void main().catch((error) => {
  console.error(`Error: ${formatCliError(error)}`);
  process.exitCode = 1;
});
