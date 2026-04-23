import {
  readScopedAgmoConfig,
  resetSessionStartPolicy,
  resolveSessionStartPolicy,
  setSessionStartPolicyValue,
  unsetSessionStartPolicyValue
} from "../config/runtime.js";
import { parseScopeFlag } from "../utils/args.js";
import { resolveRuntimeRoot } from "../utils/paths.js";

function printSessionStartHelp(): void {
  console.log(`Usage:
  agmo session-start config show [--scope user|project]
  agmo session-start config set <key> <value> [--scope user|project]
  agmo session-start config unset <key> [--scope user|project]
  agmo session-start config reset [--scope user|project]

Examples:
  agmo session-start config show
  agmo session-start config show --scope project
  agmo session-start config set mode compact --scope project
  agmo session-start config set mode debug --scope project
  agmo session-start config set show_launch_policy_source true --scope project
  agmo session-start config unset mode --scope project
  agmo session-start config reset --scope project
`);
}

function parseBooleanValue(raw: string | undefined, flagName: string): boolean {
  if (!raw) {
    throw new Error(`missing value for ${flagName}`);
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`${flagName} must be true|false`);
}

function parseSessionStartPolicyKey(
  raw: string | undefined,
  usage: string
): "mode" | "show_launch_policy_source" {
  if (raw === "mode" || raw === "show_launch_policy_source") {
    return raw;
  }

  throw new Error(usage);
}

function parseSessionStartModeValue(
  raw: string | undefined
): "compact" | "full" | "debug" {
  if (raw === "compact" || raw === "full" || raw === "debug") {
    return raw;
  }

  throw new Error("<value> must be compact|full|debug");
}

export async function runSessionStartCommand(args: string[]): Promise<void> {
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    printSessionStartHelp();
    return;
  }

  const projectRoot = resolveRuntimeRoot();
  const subcommand = args[0];

  if (subcommand !== "config") {
    printSessionStartHelp();
    return;
  }

  const action = args[1];

  if (action === "show") {
    const configArgs = args.slice(2);
    const scope =
      configArgs.includes("--scope") || configArgs.some((arg) => arg.startsWith("--scope="))
        ? parseScopeFlag(configArgs)
        : null;

    if (scope) {
      const scoped = await readScopedAgmoConfig(scope, projectRoot);
      console.log(
        JSON.stringify(
          {
            command: "session-start config show",
            mode: "scoped",
            scope,
            config_path: scoped.config_path,
            session_start: scoped.config.session_start ?? {}
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
          command: "session-start config show",
          mode: "effective",
          ...(await resolveSessionStartPolicy(projectRoot))
        },
        null,
        2
      )
    );
    return;
  }

  if (action === "set") {
    const key = parseSessionStartPolicyKey(
      args[2],
      "usage: agmo session-start config set <mode|show_launch_policy_source> <value> [--scope user|project]"
    );
    const scope = parseScopeFlag(args.slice(4));
    const value =
      key === "mode"
        ? parseSessionStartModeValue(args[3])
        : parseBooleanValue(args[3], "<value>");

    const result = await setSessionStartPolicyValue({
      key,
      value,
      scope,
      cwd: projectRoot
    });
    console.log(
      JSON.stringify(
        {
          command: "session-start config set",
          ...result
        },
        null,
        2
      )
    );
    return;
  }

  if (action === "unset") {
    const key = parseSessionStartPolicyKey(
      args[2],
      "usage: agmo session-start config unset <mode|show_launch_policy_source> [--scope user|project]"
    );
    const scope = parseScopeFlag(args.slice(3));
    const result = await unsetSessionStartPolicyValue({
      key,
      scope,
      cwd: projectRoot
    });
    console.log(
      JSON.stringify(
        {
          command: "session-start config unset",
          ...result
        },
        null,
        2
      )
    );
    return;
  }

  if (action === "reset") {
    const scope = parseScopeFlag(args.slice(2));
    const result = await resetSessionStartPolicy({
      scope,
      cwd: projectRoot
    });
    console.log(
      JSON.stringify(
        {
          command: "session-start config reset",
          ...result
        },
        null,
        2
      )
    );
    return;
  }

  throw new Error(
    "usage: agmo session-start config <show [--scope user|project]|set <key> <value> [--scope user|project]|unset <key> [--scope user|project]|reset [--scope user|project]>"
  );
}
