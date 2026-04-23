import type { InstallScope } from "../utils/paths.js";
import { resolveRuntimeRoot } from "../utils/paths.js";
import {
  addWisdomEntry,
  readEffectiveWisdom,
  readWisdomStore,
  resetWisdomStore
} from "../wisdom/store.js";

function printWisdomHelp(): void {
  console.log(`Usage:
  agmo wisdom show [--scope user|project]
  agmo wisdom add <learn|decision|issue> <content> [--scope user|project]
  agmo wisdom reset [--scope user|project]

Examples:
  agmo wisdom show
  agmo wisdom show --scope user
  agmo wisdom add learn "Prefer JSON-first CLI output."
  agmo wisdom add decision "SessionStart should merge user + project wisdom." --scope project
  agmo wisdom add issue "Remove remaining OMX startup dependency." --scope project
  agmo wisdom reset --scope project
`);
}

function parseWisdomScope(args: string[]): InstallScope | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--scope") {
      if (next === "user" || next === "project") {
        return next;
      }
      throw new Error("Expected --scope user|project");
    }

    if (arg === "--scope=user") {
      return "user";
    }

    if (arg === "--scope=project") {
      return "project";
    }
  }

  return null;
}

export async function runWisdomCommand(args: string[]): Promise<void> {
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help" || args.length === 0) {
    printWisdomHelp();
    return;
  }

  const cwd = resolveRuntimeRoot();
  const action = args[0];

  if (action === "show") {
    const scope = parseWisdomScope(args.slice(1));

    if (scope) {
      const summary = await readWisdomStore(scope, cwd);
      console.log(
        JSON.stringify(
          {
            command: "wisdom show",
            mode: "scoped",
            scope,
            path: summary.path,
            entry_count: summary.entries.length,
            entries: summary.entries
          },
          null,
          2
        )
      );
      return;
    }

    const effective = await readEffectiveWisdom(cwd);
    console.log(
      JSON.stringify(
        {
          command: "wisdom show",
          mode: "effective",
          user: {
            path: effective.user.path,
            entry_count: effective.user.entries.length,
            entries: effective.user.entries
          },
          project: {
            path: effective.project.path,
            entry_count: effective.project.entries.length,
            entries: effective.project.entries
          },
          merged_count: effective.merged.length
        },
        null,
        2
      )
    );
    return;
  }

  if (action === "add") {
    const kind = args[1];
    const scope = parseWisdomScope(args.slice(3)) ?? "project";
    const content = args[2];

    if (!kind || !content) {
      throw new Error(
        "usage: agmo wisdom add <learn|decision|issue> <content> [--scope user|project]"
      );
    }

    const result = await addWisdomEntry({
      scope,
      kind,
      content,
      cwd
    });
    console.log(
      JSON.stringify(
        {
          command: "wisdom add",
          ...result
        },
        null,
        2
      )
    );
    return;
  }

  if (action === "reset") {
    const scope = parseWisdomScope(args.slice(1)) ?? "project";
    const result = await resetWisdomStore({ scope, cwd });
    console.log(
      JSON.stringify(
        {
          command: "wisdom reset",
          ...result
        },
        null,
        2
      )
    );
    return;
  }

  throw new Error(
    "usage: agmo wisdom <show [--scope user|project]|add <learn|decision|issue> <content> [--scope user|project]|reset [--scope user|project]>"
  );
}
