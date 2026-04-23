import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { syncAgents } from "./agents.js";
import { syncManagedAgentsMd } from "../agents/agents-md.js";
import { buildAgmoRuntimeConfig, loadAgentsTemplate } from "../config/generator.js";
import { syncHooks } from "./hooks.js";
import { hasFlag, parseOptionalScopeFlag, parseScopeFlag } from "../utils/args.js";
import { ensureDir, readTextFileIfExists, writeJsonFile } from "../utils/fs.js";
import { agmoCliPackageRoot, type InstallScope, resolveInstallPaths } from "../utils/paths.js";

const AGMO_CODEX_PLUGIN_MARKETPLACE = "agmo-local";
const AGMO_CODEX_PLUGIN_NAME = "agmo";
const AGMO_DEFAULT_TUI_STATUS_LINE =
  'status_line = ["model-with-reasoning", "current-dir", "context-usage", "five-hour-limit", "weekly-limit"]';

export type SetupScopePrompt = () => Promise<InstallScope>;

export type SetupScopeOptions = {
  interactive?: boolean;
  prompt?: SetupScopePrompt;
};

export type SetupScopeResolution = {
  scope: InstallScope;
  source: "explicit" | "prompt";
};

export type CodexPluginInstallResult = {
  scope: InstallScope;
  source: "packaged" | "generated";
  plugin_name: string;
  plugin_version: string;
  plugin_key: string;
  marketplace_name: string;
  marketplace_root: string;
  plugin_source_dir: string;
  cache_dir: string;
  config_file: string;
};

type CodexPluginManifest = {
  name: string;
  version: string;
  description?: string;
  skills?: string;
  mcpServers?: string;
  interface?: Record<string, unknown>;
};

async function readJsonFile<T>(path: string): Promise<T | null> {
  const content = await readTextFileIfExists(path);
  if (!content) {
    return null;
  }

  return JSON.parse(content) as T;
}

function isInteractiveSetup(options?: SetupScopeOptions): boolean {
  if (typeof options?.interactive === "boolean") {
    return options.interactive;
  }

  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function promptForSetupScope(): Promise<InstallScope> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    process.stdout.write(
      [
        "Choose setup scope:",
        "  1) user/global — install into ~/.codex and ~/.agmo",
        "  2) project     — install into this project's .codex and .agmo"
      ].join("\n") + "\n"
    );

    while (true) {
      const answer = (await rl.question("Scope [user/project]: ")).trim().toLowerCase();

      if (["1", "u", "user", "global"].includes(answer)) {
        return "user";
      }

      if (["2", "p", "project", "local"].includes(answer)) {
        return "project";
      }

      process.stdout.write("Please enter user/global or project.\n");
    }
  } finally {
    rl.close();
  }
}

export async function resolveSetupScope(
  args: string[],
  options?: SetupScopeOptions
): Promise<SetupScopeResolution> {
  const explicitScope = parseOptionalScopeFlag(args);
  if (explicitScope) {
    return {
      scope: explicitScope,
      source: "explicit"
    };
  }

  if (!isInteractiveSetup(options)) {
    throw new Error("Missing --scope user|project. Run interactively to choose a scope.");
  }

  const prompt = options?.prompt ?? promptForSetupScope;
  return {
    scope: await prompt(),
    source: "prompt"
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTomlTable(content: string, tableName: string): string {
  const pattern = new RegExp(
    `(?:^|\\n)\\[${escapeRegExp(tableName)}\\]\\n(?:.*\\n)*?(?=(?:\\n\\[)|$)`,
    "g"
  );

  return content.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function appendTomlTable(content: string, tableName: string, body: string): string {
  const cleaned = stripTomlTable(content, tableName).trimEnd();
  const prefix = cleaned.length > 0 ? `${cleaned}\n\n` : "";
  return `${prefix}[${tableName}]\n${body.trimEnd()}\n`;
}

function ensureTomlTableSetting(content: string, tableName: string, settingName: string, settingLine: string): string {
  const pattern = new RegExp(`(^|\\n)(\\[${escapeRegExp(tableName)}\\]\\n)([\\s\\S]*?)(?=(?:\\n\\[)|$)`);
  const match = pattern.exec(content);

  if (!match) {
    return appendTomlTable(content, tableName, settingLine);
  }

  if (new RegExp(`^${escapeRegExp(settingName)}\\s*=`, "m").test(match[3])) {
    return content;
  }

  const body = match[3].trimEnd();
  const replacement = `${match[1]}${match[2]}${body.length > 0 ? `${body}\n` : ""}${settingLine}\n`;
  return `${content.slice(0, match.index)}${replacement}${content.slice(match.index + match[0].length)}`;
}


function stripLegacyCodexConfig(content: string): string {
  const blocks: string[][] = [];
  let currentBlock: string[] = [];

  for (const line of content.split("\n")) {
    if (/^\[[^\]]+\]$/.test(line) && currentBlock.length > 0) {
      blocks.push(currentBlock);
      currentBlock = [line];
      continue;
    }

    currentBlock.push(line);
  }

  if (currentBlock.length > 0) {
    blocks.push(currentBlock);
  }

  let next = blocks
    .filter(
      (block) => !block.some((line) => /\/dist\/mcp\//.test(line) || /codex-native-hook\.js/.test(line))
    )
    .map((block) => block.join("\n"))
    .join("\n")
    .split("\n")
    .filter((line) => {
      if (/notify-hook\.js/.test(line)) {
        return false;
      }

      if (/USE_[A-Z_]*EXPLORE_CMD/.test(line)) {
        return false;
      }

      if (/developer_instructions\s*=/.test(line) && /AGENTS\.md is your orchestration brain/.test(line)) {
        return false;
      }

      if (/top-level settings|seeded behavioral defaults|Managed by .* setup|End .* defaults/.test(line)) {
        return false;
      }

      return true;
    })
    .join("\n");

  next = next
    .replace(/(?:^|\n)\[env\]\n(?=(?:\n\[)|$)/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return next.length > 0 ? `${next}\n` : "";
}

function buildFallbackPluginManifest(version: string): CodexPluginManifest {
  return {
    name: AGMO_CODEX_PLUGIN_NAME,
    version,
    description: "Codex-native workflow and knowledge plugin for Agmo",
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    interface: {
      label: "Agmo"
    }
  };
}

async function resolveBundledPluginTemplate(): Promise<{
  source: "packaged" | "generated";
  manifest: CodexPluginManifest;
  packageRoot: string | null;
}> {
  const packageRoots = [
    join(agmoCliPackageRoot(), "dist", "plugin"),
    join(agmoCliPackageRoot(), "..", "agmo-plugin")
  ];

  for (const packageRoot of packageRoots) {
    const manifestPath = join(packageRoot, ".codex-plugin", "plugin.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as CodexPluginManifest;
      return {
        source: "packaged",
        manifest,
        packageRoot
      };
    }
  }

  const cliPackage = await readJsonFile<{ version?: string }>(join(agmoCliPackageRoot(), "package.json"));
  return {
    source: "generated",
    manifest: buildFallbackPluginManifest(cliPackage?.version ?? "0.1.0"),
    packageRoot: null
  };
}

async function writeGeneratedPluginBundle(
  pluginDir: string,
  manifest: CodexPluginManifest
): Promise<void> {
  await ensureDir(join(pluginDir, ".codex-plugin"));
  await ensureDir(join(pluginDir, "skills"));
  await ensureDir(join(pluginDir, "assets"));
  await writeFile(join(pluginDir, ".codex-plugin", "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    join(pluginDir, ".mcp.json"),
    `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`
  );
}

async function writeMarketplaceManifest(
  marketplaceRoot: string,
  pluginName: string
): Promise<void> {
  const marketplaceManifest = {
    name: AGMO_CODEX_PLUGIN_MARKETPLACE,
    plugins: [
      {
        name: pluginName,
        source: {
          source: "local",
          path: `./plugins/${pluginName}`
        },
        policy: {
          installation: "AVAILABLE"
        }
      }
    ]
  };

  await ensureDir(join(marketplaceRoot, ".agents", "plugins"));
  await writeFile(
    join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
    `${JSON.stringify(marketplaceManifest, null, 2)}\n`
  );
}

async function writeScopedCodexPluginConfig(args: {
  configPath: string;
  marketplaceRoot: string;
  pluginKey: string;
}): Promise<void> {
  const existing = stripLegacyCodexConfig((await readTextFileIfExists(args.configPath)) ?? "");
  let next = appendTomlTable(
    existing,
    `marketplaces.${AGMO_CODEX_PLUGIN_MARKETPLACE}`,
    [
      `last_updated = ${JSON.stringify(new Date().toISOString())}`,
      'source_type = "local"',
      `source = ${JSON.stringify(args.marketplaceRoot)}`
    ].join("\n")
  );

  next = appendTomlTable(
    next,
    `plugins.${JSON.stringify(args.pluginKey)}`,
    'enabled = true'
  );
  next = ensureTomlTableSetting(next, "tui", "status_line", AGMO_DEFAULT_TUI_STATUS_LINE);

  await ensureDir(dirname(args.configPath));
  await writeFile(args.configPath, next);
}

export async function installScopedCodexPlugin(
  scope: InstallScope,
  cwd = process.cwd()
): Promise<CodexPluginInstallResult> {
  const paths = resolveInstallPaths(scope, cwd);
  const template = await resolveBundledPluginTemplate();
  const pluginName = template.manifest.name || AGMO_CODEX_PLUGIN_NAME;
  const marketplaceRoot = join(paths.codexDir, "plugins", "marketplaces", AGMO_CODEX_PLUGIN_MARKETPLACE);
  const pluginSourceDir = join(marketplaceRoot, "plugins", pluginName);
  const pluginCacheRoot = join(paths.codexDir, "plugins", "cache", AGMO_CODEX_PLUGIN_MARKETPLACE, pluginName);

  await rm(pluginSourceDir, { recursive: true, force: true });
  await ensureDir(join(marketplaceRoot, "plugins"));
  if (template.packageRoot) {
    await cp(template.packageRoot, pluginSourceDir, { recursive: true });
  } else {
    await writeGeneratedPluginBundle(pluginSourceDir, template.manifest);
  }

  const manifest = JSON.parse(
    await readFile(join(pluginSourceDir, ".codex-plugin", "plugin.json"), "utf-8")
  ) as CodexPluginManifest;
  const pluginVersion = manifest.version;
  const cacheDir = join(pluginCacheRoot, pluginVersion);
  const pluginKey = `${pluginName}@${AGMO_CODEX_PLUGIN_MARKETPLACE}`;
  const configFile = join(paths.codexDir, "config.toml");

  await rm(pluginCacheRoot, { recursive: true, force: true });
  await ensureDir(pluginCacheRoot);
  await cp(pluginSourceDir, cacheDir, { recursive: true });
  await writeMarketplaceManifest(marketplaceRoot, pluginName);
  await writeScopedCodexPluginConfig({
    configPath: configFile,
    marketplaceRoot,
    pluginKey
  });

  return {
    scope,
    source: template.source,
    plugin_name: pluginName,
    plugin_version: pluginVersion,
    plugin_key: pluginKey,
    marketplace_name: AGMO_CODEX_PLUGIN_MARKETPLACE,
    marketplace_root: marketplaceRoot,
    plugin_source_dir: pluginSourceDir,
    cache_dir: cacheDir,
    config_file: configFile
  };
}

export async function runSetupCommand(args: string[]): Promise<void> {
  const scopeResolution = await resolveSetupScope(args);
  const scope = scopeResolution.scope;
  const force = hasFlag(args, "--force");
  const paths = resolveInstallPaths(scope);

  const agentSummary = await syncAgents(scope);
  const hookSummary = await syncHooks(scope);
  const pluginSummary = await installScopedCodexPlugin(scope);

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
        scope_source: scopeResolution.source,
        force,
        outputs: {
          agents: agentSummary,
          hooks: hookSummary,
          plugin: pluginSummary,
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
