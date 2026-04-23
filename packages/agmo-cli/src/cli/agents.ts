import { rm } from "node:fs/promises";
import {
  AGMO_AGENT_DEFINITIONS
} from "../agents/definitions.js";
import {
  buildInitialAgentTomlMap,
  buildManagedPromptMirrorMap
} from "../agents/native-config.js";
import { parseScopeFlag } from "../utils/args.js";
import { ensureDir, writeTextFile } from "../utils/fs.js";
import { type InstallScope, resolveInstallPaths } from "../utils/paths.js";

export async function syncAgents(
  scope: InstallScope,
  cwd = process.cwd()
): Promise<Record<string, unknown>> {
  const paths = resolveInstallPaths(scope, cwd);
  await Promise.all([ensureDir(paths.agentsDir), ensureDir(paths.promptsDir)]);
  const [agentTomls, promptMirrors] = await Promise.all([
    buildInitialAgentTomlMap(),
    buildManagedPromptMirrorMap()
  ]);
  const removedLegacyFiles = await Promise.all(
    AGMO_AGENT_DEFINITIONS.flatMap((agent) =>
      (agent.legacyNames ?? []).map(async (legacyName) => {
        const legacyPath = `${paths.agentsDir}/${legacyName}.toml`;
        try {
          await rm(legacyPath);
          return legacyPath;
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error
              ? String(error.code)
              : "";
          if (code === "ENOENT") {
            return null;
          }
          throw error;
        }
      })
    )
  );

  const writes = await Promise.all(
    Object.entries(agentTomls).map(async ([name, content]) => {
      const path = `${paths.agentsDir}/${name}.toml`;
      return {
        name,
        path,
        write: await writeTextFile(path, content)
      };
    })
  );

  const mirroredPrompts = await Promise.all(
    Object.entries(promptMirrors).map(async ([fileName, content]) => {
      const path = `${paths.promptsDir}/${fileName}`;
      return {
        file: fileName,
        path,
        write: await writeTextFile(path, content)
      };
    })
  );

  return {
    scope,
    target_dir: paths.agentsDir,
    prompts_target_dir: paths.promptsDir,
    count: writes.length,
    mirrored_prompt_count: mirroredPrompts.length,
    removed_legacy_files: removedLegacyFiles.filter((path): path is string => path !== null),
    files: writes,
    mirrored_prompts: mirroredPrompts
  };
}

export async function runAgentsCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === "sync") {
    const scope = parseScopeFlag(args.slice(1));
    const summary = await syncAgents(scope);

    console.log(
      JSON.stringify(
        {
          command: "agents sync",
          agents: AGMO_AGENT_DEFINITIONS.map((agent) => agent.name),
          summary
        },
        null,
        2
      )
    );
    return;
  }

  console.log("Usage: agmo agents sync");
  process.exitCode = 1;
}
