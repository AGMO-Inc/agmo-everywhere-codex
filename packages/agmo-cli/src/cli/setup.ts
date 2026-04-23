import os from "node:os";
import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { syncAgents } from "./agents.js";
import { syncManagedAgentsMd } from "../agents/agents-md.js";
import { buildAgmoRuntimeConfig, loadAgentsTemplate } from "../config/generator.js";
import { syncHooks } from "./hooks.js";
import { hasFlag, parseScopeFlag } from "../utils/args.js";
import { ensureDir, readTextFileIfExists, writeJsonFile } from "../utils/fs.js";
import { resolveInstallPaths } from "../utils/paths.js";

type LegacyRuntimeMigrationMode = "archive" | "delete";

export type LegacyRuntimeMigrationResult = {
  command: "setup migrate-legacy";
  scope: "project" | "user";
  mode: LegacyRuntimeMigrationMode;
  source_path: string;
  status: "archived" | "deleted" | "skipped";
  archive_path: string | null;
};

async function readJsonFile<T>(path: string): Promise<T | null> {
  const content = await readTextFileIfExists(path);
  if (!content) {
    return null;
  }

  return JSON.parse(content) as T;
}

export function resolveLegacyRuntimePaths(
  scope: "project" | "user",
  cwd = process.cwd(),
  userHome = os.homedir()
): { sourcePath: string; archiveRoot: string } {
  if (scope === "user") {
    return {
      sourcePath: join(userHome, ".omx"),
      archiveRoot: join(userHome, ".agmo", "legacy", "omx")
    };
  }

  return {
    sourcePath: join(cwd, ".omx"),
    archiveRoot: join(cwd, ".agmo", "legacy", "omx")
  };
}

export async function migrateLegacyRuntimeArtifacts(args: {
  scope: "project" | "user";
  cwd?: string;
  userHome?: string;
  mode?: LegacyRuntimeMigrationMode;
  now?: Date;
}): Promise<LegacyRuntimeMigrationResult> {
  const mode = args.mode ?? "archive";
  const { sourcePath, archiveRoot } = resolveLegacyRuntimePaths(
    args.scope,
    args.cwd,
    args.userHome
  );

  if (!existsSync(sourcePath)) {
    return {
      command: "setup migrate-legacy",
      scope: args.scope,
      mode,
      source_path: sourcePath,
      status: "skipped",
      archive_path: null
    };
  }

  if (mode === "delete") {
    await rm(sourcePath, { recursive: true, force: true });
    return {
      command: "setup migrate-legacy",
      scope: args.scope,
      mode,
      source_path: sourcePath,
      status: "deleted",
      archive_path: null
    };
  }

  const timestamp = (args.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const archivePath = join(archiveRoot, `${args.scope}-${timestamp}`);
  await ensureDir(archiveRoot);
  await rename(sourcePath, archivePath);

  return {
    command: "setup migrate-legacy",
    scope: args.scope,
    mode,
    source_path: sourcePath,
    status: "archived",
    archive_path: archivePath
  };
}

export async function runSetupCommand(args: string[]): Promise<void> {
  if (args[0] === "migrate-legacy") {
    const mode = hasFlag(args, "--delete") ? "delete" : "archive";
    console.log(
      JSON.stringify(
        await migrateLegacyRuntimeArtifacts({
          scope: parseScopeFlag(args.slice(1)),
          mode
        }),
        null,
        2
      )
    );
    return;
  }

  const scope = parseScopeFlag(args);
  const force = hasFlag(args, "--force");
  const paths = resolveInstallPaths(scope);

  const agentSummary = await syncAgents(scope);
  const hookSummary = await syncHooks(scope);

  const agentsTemplate = await loadAgentsTemplate();

  const createdDirs = await Promise.all([
    ensureDir(paths.codexDir),
    ensureDir(paths.agentsDir),
    ensureDir(paths.agmoDir),
    ensureDir(paths.stateDir),
    ensureDir(paths.teamStateDir),
    ensureDir(paths.sessionsStateDir),
    ensureDir(paths.workflowsStateDir),
    ensureDir(paths.logsDir),
    ensureDir(paths.memoryDir),
    ensureDir(paths.cacheDir),
    ensureDir(paths.sessionInstructionsDir)
  ]);
  const agentsMdResult = await syncManagedAgentsMd({
    scope,
    force,
    agentsTemplate,
    agentsMdFile: paths.agentsMdFile,
    agmoDir: paths.agmoDir,
    sessionsStateDir: paths.sessionsStateDir,
    workflowsStateDir: paths.workflowsStateDir
  });

  const existingConfig =
    (await readJsonFile<Record<string, unknown>>(paths.agmoConfigFile)) ?? {};
  const generatedConfig = buildAgmoRuntimeConfig(scope, paths);
  const configResult = await writeJsonFile(
    paths.agmoConfigFile,
    {
      ...existingConfig,
      ...generatedConfig,
      launch: {
        ...((generatedConfig.launch as Record<string, unknown> | undefined) ?? {}),
        ...((existingConfig.launch as Record<string, unknown> | undefined) ?? {})
      },
      session_start: {
        ...((generatedConfig.session_start as Record<string, unknown> | undefined) ?? {}),
        ...((existingConfig.session_start as Record<string, unknown> | undefined) ?? {})
      },
      vault_autosave: {
        ...((generatedConfig.vault_autosave as Record<string, unknown> | undefined) ?? {}),
        ...((existingConfig.vault_autosave as Record<string, unknown> | undefined) ?? {}),
        workflow_types: {
          ...(((generatedConfig.vault_autosave as Record<string, unknown> | undefined)
            ?.workflow_types as Record<string, unknown> | undefined) ?? {}),
          ...(((existingConfig.vault_autosave as Record<string, unknown> | undefined)
            ?.workflow_types as Record<string, unknown> | undefined) ?? {})
        }
      }
    }
  );

  console.log(
    JSON.stringify(
      {
        command: "setup",
        scope,
        force,
        outputs: {
          agents: agentSummary,
          hooks: hookSummary,
          agents_md: agentsMdResult,
          agmo_config: configResult
        },
        ensured_directories: createdDirs,
        paths: {
          codex_dir: paths.codexDir,
          agents_dir: paths.agentsDir,
          hooks_file: paths.hooksFile,
          agents_md_file: paths.agentsMdFile,
          agmo_dir: paths.agmoDir,
          session_instructions_dir: paths.sessionInstructionsDir
        }
      },
      null,
      2
    )
  );
}
