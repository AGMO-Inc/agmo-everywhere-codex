import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CHANNEL_ORDER = ["alpha", "beta", "rc"];
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-(alpha|beta|rc)\.\d+)?$/;

export async function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const checkOnly = args.includes("--check");
  const positional = args.filter((arg) => arg !== "--check");

  if (positional.length > 1) {
    throw new Error(
      "usage: node scripts/sync-versions.mjs [--check] [version|patch|minor|major|alpha|beta|rc|release]"
    );
  }

  const rootPackagePath = resolve(repoRoot, "package.json");
  const cliPackagePath = resolve(repoRoot, "packages/agmo-cli/package.json");
  const pluginPackagePath = resolve(repoRoot, "packages/agmo-plugin/package.json");
  const pluginManifestPath = resolve(repoRoot, "packages/agmo-plugin/.codex-plugin/plugin.json");
  const readmePath = resolve(repoRoot, "README.md");

  const rootPackage = await readJson(rootPackagePath);
  const nextVersion = resolveNextVersion(rootPackage.version, positional[0]);

  if (!isValidVersion(nextVersion)) {
    throw new Error(`resolved version is invalid: ${nextVersion}`);
  }

  const updates = [];

  updates.push(
    await syncJsonVersion(rootPackagePath, rootPackage, nextVersion, checkOnly),
    await syncJsonVersion(cliPackagePath, await readJson(cliPackagePath), nextVersion, checkOnly),
    await syncJsonVersion(
      pluginPackagePath,
      await readJson(pluginPackagePath),
      nextVersion,
      checkOnly
    ),
    await syncJsonVersion(
      pluginManifestPath,
      await readJson(pluginManifestPath),
      nextVersion,
      checkOnly
    ),
    await syncReadmeVersion(readmePath, nextVersion, checkOnly)
  );

  const changed = updates.filter(Boolean);

  if (checkOnly && changed.length > 0) {
    console.error("Version drift detected in:");
    for (const file of changed) {
      console.error(`- ${file}`);
    }
    process.exitCode = 1;
    return;
  }

  for (const file of changed) {
    console.log(`updated ${file}`);
  }
}

export function isValidVersion(value) {
  return VERSION_PATTERN.test(value);
}

export function parseVersion(value) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/);
  if (!match) {
    return null;
  }

  const [, majorPart, minorPart, patchPart, channel = null, prereleasePart] = match;
  return {
    major: Number(majorPart),
    minor: Number(minorPart),
    patch: Number(patchPart),
    channel,
    prereleaseNumber: channel ? Number(prereleasePart) : null
  };
}

export function formatVersion(version) {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  if (!version.channel) {
    return base;
  }
  return `${base}-${version.channel}.${version.prereleaseNumber}`;
}

export function resolveNextVersion(currentVersion, request) {
  const current = parseManagedVersion(currentVersion, "root package.json has an invalid version");

  if (!request) {
    return formatVersion(current);
  }

  if (isValidVersion(request)) {
    return request;
  }

  if (request === "patch" || request === "minor" || request === "major") {
    return bumpStable(current, request);
  }

  if (request === "alpha" || request === "beta" || request === "rc") {
    return advancePrerelease(current, request);
  }

  if (request === "release") {
    return releaseVersion(current);
  }

  throw new Error(`invalid version: ${request}`);
}

function parseManagedVersion(value, messagePrefix) {
  const parsed = parseVersion(value);
  if (!parsed) {
    throw new Error(`${messagePrefix}: ${value}`);
  }
  return parsed;
}

function bumpStable(current, level) {
  if (level === "major") {
    return formatVersion({
      major: current.major + 1,
      minor: 0,
      patch: 0,
      channel: null,
      prereleaseNumber: null
    });
  }

  if (level === "minor") {
    return formatVersion({
      major: current.major,
      minor: current.minor + 1,
      patch: 0,
      channel: null,
      prereleaseNumber: null
    });
  }

  return formatVersion({
    major: current.major,
    minor: current.minor,
    patch: current.patch + 1,
    channel: null,
    prereleaseNumber: null
  });
}

function advancePrerelease(current, nextChannel) {
  if (!current.channel) {
    return formatVersion({
      major: current.major,
      minor: current.minor,
      patch: current.patch + 1,
      channel: nextChannel,
      prereleaseNumber: 0
    });
  }

  const currentIndex = CHANNEL_ORDER.indexOf(current.channel);
  const nextIndex = CHANNEL_ORDER.indexOf(nextChannel);

  if (nextIndex < currentIndex) {
    throw new Error(
      `cannot move prerelease backward from ${current.channel} to ${nextChannel}; use an explicit version or bump a new patch`
    );
  }

  if (nextIndex === currentIndex) {
    return formatVersion({
      ...current,
      prereleaseNumber: (current.prereleaseNumber ?? 0) + 1
    });
  }

  return formatVersion({
    ...current,
    channel: nextChannel,
    prereleaseNumber: 0
  });
}

function releaseVersion(current) {
  return formatVersion({
    major: current.major,
    minor: current.minor,
    patch: current.patch,
    channel: null,
    prereleaseNumber: null
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function syncJsonVersion(path, json, version, check) {
  const next = `${JSON.stringify({ ...json, version }, null, 2)}\n`;
  const current = `${JSON.stringify(json, null, 2)}\n`;
  if (current === next) {
    return null;
  }
  if (!check) {
    await writeFile(path, next);
  }
  return relativeRepoPath(path);
}

async function syncReadmeVersion(path, version, check) {
  const current = await readFile(path, "utf8");
  const badgeVersion = escapeBadgeValue(version);
  const pattern =
    /\[!\[Version\]\(https:\/\/img\.shields\.io\/badge\/version-[^)]+-1f2937\.svg\)\]\(package\.json\)/;

  if (!pattern.test(current)) {
    throw new Error("README.md version badge pattern not found");
  }

  const next = current.replace(
    pattern,
    `[![Version](https://img.shields.io/badge/version-${badgeVersion}-1f2937.svg)](package.json)`
  );

  if (current === next) {
    return null;
  }

  if (!check) {
    await writeFile(path, next);
  }

  return relativeRepoPath(path);
}

function escapeBadgeValue(value) {
  return value.replace(/-/g, "--").replace(/_/g, "__").replace(/ /g, "_");
}

function relativeRepoPath(path) {
  return path.slice(repoRoot.length + 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
