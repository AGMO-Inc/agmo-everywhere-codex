import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidVersion } from "./sync-versions.mjs";

const defaultRepoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export async function validatePluginBundle(repoRoot = defaultRepoRoot) {
  const pluginRoot = resolve(repoRoot, "packages/agmo-plugin");
  const mirrorRoot = resolve(repoRoot, ".codex/skills");
  const packagePath = resolve(pluginRoot, "package.json");
  const manifestPath = resolve(pluginRoot, ".codex-plugin/plugin.json");
  const mcpPath = resolve(pluginRoot, ".mcp.json");
  const skillsRoot = resolve(pluginRoot, "skills");
  const assetsRoot = resolve(pluginRoot, "assets");
  const issues = [];

  await expectReadable(packagePath, issues, "plugin package.json is missing");
  await expectReadable(manifestPath, issues, "plugin manifest is missing");
  await expectReadable(mcpPath, issues, "plugin .mcp.json is missing");
  await expectReadable(skillsRoot, issues, "plugin skills directory is missing");
  await expectReadable(assetsRoot, issues, "plugin assets directory is missing");
  await expectReadable(mirrorRoot, issues, "repo .codex/skills mirror is missing");

  if (issues.length > 0) {
    return issues;
  }

  const pluginPackage = JSON.parse(await readFile(packagePath, "utf8"));
  const pluginManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const mcpConfig = JSON.parse(await readFile(mcpPath, "utf8"));

  if (pluginPackage.name !== "@agmo/plugin") {
    issues.push(`unexpected plugin package name: ${pluginPackage.name}`);
  }

  if (!isValidVersion(pluginPackage.version)) {
    issues.push(`plugin package version is invalid: ${pluginPackage.version}`);
  }

  if (pluginManifest.name !== "agmo") {
    issues.push(`unexpected plugin manifest name: ${pluginManifest.name}`);
  }

  if (!isValidVersion(pluginManifest.version)) {
    issues.push(`plugin manifest version is invalid: ${pluginManifest.version}`);
  }

  if (pluginPackage.version !== pluginManifest.version) {
    issues.push(
      `plugin package version ${pluginPackage.version} does not match plugin manifest version ${pluginManifest.version}`
    );
  }

  if (pluginManifest.skills !== "./skills/") {
    issues.push(`plugin manifest skills path must be ./skills/, received ${pluginManifest.skills}`);
  }

  if (pluginManifest.mcpServers !== "./.mcp.json") {
    issues.push(
      `plugin manifest MCP path must be ./.mcp.json, received ${pluginManifest.mcpServers}`
    );
  }

  if (pluginManifest.interface?.label !== "Agmo") {
    issues.push("plugin manifest interface.label must be Agmo");
  }

  if (!mcpConfig.mcpServers || typeof mcpConfig.mcpServers !== "object") {
    issues.push("plugin .mcp.json must define an mcpServers object");
  }

  const pluginSkillEntries = await collectSkillEntries(skillsRoot);
  const mirrorSkillEntries = await collectSkillEntries(mirrorRoot);
  const pluginSkillNames = [...pluginSkillEntries.keys()].sort();
  const mirrorSkillNames = [...mirrorSkillEntries.keys()].sort();

  if (pluginSkillNames.length === 0) {
    issues.push("plugin skills directory is empty");
  }

  if (pluginSkillNames.join("\n") !== mirrorSkillNames.join("\n")) {
    issues.push(
      "plugin skill directories do not match .codex/skills mirror"
    );
  }

  for (const [skillName, skillPath] of pluginSkillEntries) {
    const skillContents = await readFile(skillPath, "utf8");
    if (!skillContents.trimStart().startsWith("---")) {
      issues.push(`skill ${skillName} is missing frontmatter`);
    }

    const mirrorPath = mirrorSkillEntries.get(skillName);
    if (!mirrorPath) {
      continue;
    }

    const mirrorContents = await readFile(mirrorPath, "utf8");
    if (skillContents !== mirrorContents) {
      issues.push(`skill ${skillName} does not match .codex mirror`);
    }
  }

  return issues;
}

async function collectSkillEntries(skillsRoot) {
  const entries = new Map();
  const skillDirs = await readdir(skillsRoot, { withFileTypes: true });

  for (const dirent of skillDirs) {
    if (!dirent.isDirectory()) {
      continue;
    }
    if (dirent.name.startsWith(".")) {
      continue;
    }
    const skillPath = resolve(skillsRoot, dirent.name, "SKILL.md");
    await expectReadable(skillPath, null, `skill ${dirent.name} is missing SKILL.md`);
    entries.set(dirent.name, skillPath);
  }

  return entries;
}

async function expectReadable(path, issues, message) {
  try {
    await access(path, constants.R_OK);
  } catch {
    if (issues) {
      issues.push(message);
      return;
    }
    throw new Error(message);
  }
}

export async function main() {
  const issues = await validatePluginBundle();

  if (issues.length > 0) {
    console.error("Plugin validation failed:");
    for (const issue of issues) {
      console.error(`- ${issue}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("plugin bundle validated");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
