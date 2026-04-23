import os from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

export type InstallScope = "project" | "user";

export type InstallPaths = {
  scope: InstallScope;
  projectRoot: string;
  codexDir: string;
  agentsDir: string;
  hooksFile: string;
  agentsMdFile: string;
  agmoDir: string;
  agmoConfigFile: string;
  stateDir: string;
  teamStateDir: string;
  sessionsStateDir: string;
  workflowsStateDir: string;
  logsDir: string;
  memoryDir: string;
  cacheDir: string;
  handoffsDir: string;
  sessionInstructionsDir: string;
};

export function agmoCliPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function agmoCliDistEntryPath(): string {
  return join(agmoCliPackageRoot(), "dist", "cli", "index.js");
}

export function agmoCliTemplateCandidatePaths(...parts: string[]): string[] {
  const root = agmoCliPackageRoot();
  return [join(root, "src", "templates", ...parts), join(root, "dist", "templates", ...parts)];
}

export function codexHomeDir(): string {
  return resolve(process.env.CODEX_HOME || join(os.homedir(), ".codex"));
}

export function resolveInstallPaths(
  scope: InstallScope,
  cwd = process.cwd()
): InstallPaths {
  const projectRoot = resolve(cwd);
  const codexDir = scope === "project" ? join(projectRoot, ".codex") : codexHomeDir();
  const agmoDir =
    scope === "project" ? join(projectRoot, ".agmo") : resolve(os.homedir(), ".agmo");

  return {
    scope,
    projectRoot,
    codexDir,
    agentsDir: join(codexDir, "agents"),
    hooksFile: join(codexDir, "hooks.json"),
    agentsMdFile:
      scope === "project" ? join(projectRoot, "AGENTS.md") : join(codexDir, "AGENTS.md"),
    agmoDir,
    agmoConfigFile: join(agmoDir, "config.json"),
    stateDir: join(agmoDir, "state"),
    teamStateDir: join(agmoDir, "state", "team"),
    sessionsStateDir: join(agmoDir, "state", "sessions"),
    workflowsStateDir: join(agmoDir, "state", "workflows"),
    logsDir: join(agmoDir, "logs"),
    memoryDir: join(agmoDir, "memory"),
    cacheDir: join(agmoDir, "cache"),
    handoffsDir: join(agmoDir, "handoffs"),
    sessionInstructionsDir: join(agmoDir, "cache", "session-instructions")
  };
}

export function resolveRuntimeRoot(cwd = process.cwd()): string {
  return resolve(process.env.AGMO_PROJECT_ROOT || cwd);
}
