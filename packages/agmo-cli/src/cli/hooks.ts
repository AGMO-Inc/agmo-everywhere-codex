import {
  AGMO_MANAGED_HOOK_EVENTS,
  buildHookCommand,
  mergeManagedHooksConfig
} from "../hooks/codex-hooks.js";
import { parseScopeFlag } from "../utils/args.js";
import { readTextFileIfExists, writeTextFile } from "../utils/fs.js";
import {
  agmoCliDistEntryPath,
  type InstallScope,
  resolveInstallPaths
} from "../utils/paths.js";

export async function syncHooks(
  scope: InstallScope,
  cwd = process.cwd()
): Promise<Record<string, unknown>> {
  const paths = resolveInstallPaths(scope, cwd);
  const existingContent = await readTextFileIfExists(paths.hooksFile);
  const hookCommand = buildHookCommand(agmoCliDistEntryPath());
  const merged = mergeManagedHooksConfig(existingContent, hookCommand);
  const write = await writeTextFile(paths.hooksFile, merged);

  return {
    scope,
    target_file: paths.hooksFile,
    command: hookCommand,
    write
  };
}

export async function runHooksCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === "sync") {
    const scope = parseScopeFlag(args.slice(1));
    const summary = await syncHooks(scope);

    console.log(
      JSON.stringify(
        {
          command: "hooks sync",
          events: AGMO_MANAGED_HOOK_EVENTS,
          summary
        },
        null,
        2
      )
    );
    return;
  }

  console.log("Usage: agmo hooks sync");
  process.exitCode = 1;
}
