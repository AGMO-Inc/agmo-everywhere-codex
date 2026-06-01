import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { auditWiki } from "./maintain.js";
import {
  captureTitle,
  listRecentMarkdownFiles,
  projectCapsulePath,
  projectCapturesDir,
  readMarkdownFile,
  truncateChars,
  type WikiRuntime,
  wikiRelativePath,
  wisdomPath
} from "./runtime.js";

export type WikiContextMode = "manifest" | "full" | "off";
export type WikiContextFormat = "markdown" | "json";

export const DEFAULT_MANIFEST_BUDGET_CHARS = 800;
export const MANIFEST_HARD_CAP_CHARS = 800;
export const DEFAULT_FULL_BUDGET_CHARS = 6000;
export const HOOK_FULL_HARD_CAP_CHARS = 12000;

export type WikiManifestContext = {
  mode: "manifest";
  project: string;
  budget_chars: number;
  wiki_root: string;
  current_project: {
    name: string;
    capsule: { exists: boolean; updated?: string };
    capture_count: number;
    top_titles: string[];
  };
  other_projects: Array<{ name: string; capture_count: number }>;
  health?: { high_severity_issue_count: number; warning?: string };
  lazy_load: {
    full_context: string;
    search: string;
    read: string;
  };
};

export type WikiFullContext = {
  mode: "full";
  project: string;
  budget_chars: number;
  chars_used: number;
  included: Array<{ label: string; path: string; chars: number; truncated: boolean; content: string }>;
  omitted: Array<{ path: string; reason: "missing" | "budget" | "superseded" }>;
};

async function captureCount(dir: string): Promise<number> {
  return (await listRecentMarkdownFiles(dir)).length;
}

async function buildOtherProjects(runtime: WikiRuntime): Promise<Array<{ name: string; capture_count: number }>> {
  const projectsDir = join(runtime.wiki_root, "projects");
  if (!existsSync(projectsDir)) {
    return [];
  }
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(projectsDir, { withFileTypes: true });
  const names = new Set<string>();

  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== runtime.project) {
      names.add(entry.name);
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const name = basename(entry.name, ".md");
      if (name !== runtime.project) {
        names.add(name);
      }
    }
  }

  const results = await Promise.all(
    [...names].sort().map(async (name) => ({
      name,
      capture_count: await captureCount(projectCapturesDir(runtime, name))
    }))
  );

  return results;
}

export async function generateWikiManifest(args: {
  runtime: WikiRuntime;
  budgetChars?: number;
  includeHealth?: boolean;
}): Promise<WikiManifestContext> {
  const budget = Math.min(args.budgetChars ?? DEFAULT_MANIFEST_BUDGET_CHARS, MANIFEST_HARD_CAP_CHARS);
  const capsule = await readMarkdownFile(projectCapsulePath(args.runtime));
  const capturePaths = await listRecentMarkdownFiles(projectCapturesDir(args.runtime));
  const topPages = await Promise.all(capturePaths.slice(0, 3).map((path) => readMarkdownFile(path)));
  const otherProjects = await buildOtherProjects(args.runtime);
  const manifest: WikiManifestContext = {
    mode: "manifest",
    project: args.runtime.project,
    budget_chars: budget,
    wiki_root: args.runtime.wiki_root,
    current_project: {
      name: args.runtime.project,
      capsule: {
        exists: capsule !== null,
        ...(capsule?.frontmatter.updated ? { updated: capsule.frontmatter.updated } : {})
      },
      capture_count: capturePaths.length,
      top_titles: topPages
        .filter((page): page is NonNullable<typeof page> => page !== null)
        .map((page) => captureTitle(page.path, page.content, page.frontmatter))
    },
    other_projects: otherProjects,
    lazy_load: {
      full_context: `agmo wiki context --project ${args.runtime.project} --full`,
      search: "vault-search",
      read: "vault-read"
    }
  };

  if (args.includeHealth) {
    const audit = await auditWiki({ runtime: args.runtime });
    const highCount = audit.issues.filter((issue) => issue.severity === "high").length;
    manifest.health = {
      high_severity_issue_count: highCount,
      ...(highCount > 0
        ? { warning: `high-severity wiki issues: ${highCount}; run agmo wiki maintain --project ${args.runtime.project}` }
        : {})
    };
  }

  manifest.budget_chars = budget;
  return manifest;
}

export function renderWikiManifestMarkdown(manifest: WikiManifestContext): string {
  const lines = [
    `## LLM Wiki Manifest (${manifest.project})`,
    "",
    `### ${manifest.current_project.name}`,
    manifest.current_project.capsule.exists
      ? `- capsule: present${manifest.current_project.capsule.updated ? ` (updated: ${manifest.current_project.capsule.updated})` : ""}`
      : "- capsule missing - use wiki capture/migration when knowledge accumulates",
    `- captures: ${manifest.current_project.capture_count}`
  ];

  for (const title of manifest.current_project.top_titles) {
    lines.push(`  - ${title}`);
  }

  if (manifest.other_projects.length > 0) {
    lines.push("", "### Other Projects");
    for (const project of manifest.other_projects) {
      lines.push(`- ${project.name} (${project.capture_count})`);
    }
  }

  lines.push(
    "",
    `Full body: \`${manifest.lazy_load.full_context}\`; search: \`${manifest.lazy_load.search}\`; read: \`${manifest.lazy_load.read}\``,
    "Full wiki context is injected only when AGMO_CONTEXT_MODE=full."
  );

  if (manifest.health?.warning) {
    lines.push("", `WARNING: ${manifest.health.warning}`);
  }

  return truncateChars(`${lines.join("\n")}\n`, manifest.budget_chars);
}

function renderManifestJson(manifest: WikiManifestContext): string {
  const copy = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  let output = `${JSON.stringify(copy)}\n`;
  if (output.length <= manifest.budget_chars) {
    return output;
  }

  copy.other_projects = (copy.other_projects as unknown[]).slice(0, 2);
  output = `${JSON.stringify(copy)}\n`;
  if (output.length <= manifest.budget_chars) {
    return output;
  }

  const currentProject = copy.current_project as { top_titles?: string[] };
  currentProject.top_titles = currentProject.top_titles?.slice(0, 1) ?? [];
  delete copy.wiki_root;
  output = `${JSON.stringify(copy)}\n`;
  if (output.length <= manifest.budget_chars) {
    return output;
  }

  return `${JSON.stringify({
    mode: "manifest",
    project: manifest.project,
    truncated: true
  })}\n`;
}

type Candidate = {
  path: string;
  label: string;
  priority: number;
  maxChars: number;
};

async function supersededCaptureRels(runtime: WikiRuntime, captures: string[]): Promise<Set<string>> {
  const targets = new Set<string>();
  for (const path of captures) {
    const page = await readMarkdownFile(path);
    const supersedes = page?.frontmatter.supersedes?.trim();
    if (!supersedes) {
      continue;
    }
    targets.add(supersedes);
    targets.add(wikiRelativePath(runtime, join(path.slice(0, path.lastIndexOf("/")), supersedes)));
    targets.add(wikiRelativePath(runtime, join(runtime.vault_root, supersedes)));
  }
  return targets;
}

export async function generateWikiFullContext(args: {
  runtime: WikiRuntime;
  budgetChars?: number;
}): Promise<WikiFullContext> {
  const budget = args.budgetChars ?? DEFAULT_FULL_BUDGET_CHARS;
  const candidates: Candidate[] = [
    { path: join(args.runtime.wiki_root, "SCHEMA.md"), label: "LLM Wiki Schema", priority: 10, maxChars: 1800 },
    { path: join(args.runtime.wiki_root, "INDEX.md"), label: "LLM Wiki Index", priority: 20, maxChars: 2200 },
    { path: projectCapsulePath(args.runtime), label: `Project Capsule: ${args.runtime.project}`, priority: 30, maxChars: 2400 },
    { path: join(args.runtime.wiki_root, "LOG.md"), label: "Recent LLM Wiki Log", priority: 40, maxChars: 1800 }
  ];
  const omitted: WikiFullContext["omitted"] = [];
  const capturePaths = await listRecentMarkdownFiles(projectCapturesDir(args.runtime));
  const superseded = await supersededCaptureRels(args.runtime, capturePaths);
  let captureIndex = 0;
  for (const path of capturePaths) {
    const rel = wikiRelativePath(args.runtime, path);
    if (superseded.has(rel) || superseded.has(path)) {
      omitted.push({ path: rel, reason: "superseded" });
      continue;
    }
    if (captureIndex < 8) {
      candidates.push({
        path,
        label: `Recent Capture: ${basename(path)}`,
        priority: 50 + captureIndex,
        maxChars: 1800
      });
    }
    captureIndex += 1;
  }

  for (const [rel, label, priority] of [
    [`${args.runtime.project}/wisdom/learnings.md`, `${args.runtime.project} Wisdom: Learnings`, 70],
    [`${args.runtime.project}/wisdom/decisions.md`, `${args.runtime.project} Wisdom: Decisions`, 71],
    [`${args.runtime.project}/wisdom/issues.md`, `${args.runtime.project} Wisdom: Issues`, 72],
    ["shared/wisdom/learnings.md", "Shared Wisdom: Learnings", 80],
    ["shared/wisdom/decisions.md", "Shared Wisdom: Decisions", 81],
    ["shared/wisdom/issues.md", "Shared Wisdom: Issues", 82]
  ] as const) {
    candidates.push({ path: wisdomPath(args.runtime, rel), label, priority, maxChars: 1800 });
  }

  const included: WikiFullContext["included"] = [];
  let charsUsed = `## LLM Wiki Context (${args.runtime.project})\n\n`.length;

  for (const candidate of candidates.sort((left, right) => left.priority - right.priority)) {
    const page = await readMarkdownFile(candidate.path);
    const rel = wikiRelativePath(args.runtime, candidate.path);
    if (!page) {
      omitted.push({ path: rel, reason: "missing" });
      continue;
    }

    let content = page.content;
    if (candidate.label === "Recent LLM Wiki Log") {
      content = content.split(/\r?\n/u).slice(-40).join("\n");
    }
    const truncated = content.length > candidate.maxChars;
    if (truncated) {
      content = `${content.slice(0, candidate.maxChars).trimEnd()}\n... [truncated]`;
    }
    const sectionChars = `### ${candidate.label}\n_Source: \`${rel}\`_\n\n${content.trim()}\n\n`.length;
    if (charsUsed + sectionChars > budget) {
      omitted.push({ path: rel, reason: "budget" });
      continue;
    }
    included.push({
      label: candidate.label,
      path: rel,
      chars: sectionChars,
      truncated,
      content: content.trim()
    });
    charsUsed += sectionChars;
  }

  return {
    mode: "full",
    project: args.runtime.project,
    budget_chars: budget,
    chars_used: charsUsed,
    included,
    omitted
  };
}

export function renderWikiFullMarkdown(context: WikiFullContext): string {
  const lines = [`## LLM Wiki Context (${context.project})`, ""];
  for (const item of context.included) {
    lines.push(`### ${item.label}`, `_Source: \`${item.path}\`_`, "", item.content, "");
  }
  if (context.omitted.length > 0) {
    lines.push("### Omitted", ...context.omitted.map((item) => `- ${item.path}: ${item.reason}`), "");
  }
  return truncateChars(lines.join("\n"), context.budget_chars);
}

export async function renderWikiContext(args: {
  runtime: WikiRuntime;
  mode: Exclude<WikiContextMode, "off">;
  format?: WikiContextFormat;
  budgetChars?: number;
  includeHealth?: boolean;
}): Promise<string> {
  const format = args.format ?? "markdown";
  if (args.mode === "manifest") {
    const manifest = await generateWikiManifest({
      runtime: args.runtime,
      budgetChars: args.budgetChars,
      includeHealth: args.includeHealth
    });
    return format === "json" ? renderManifestJson(manifest) : renderWikiManifestMarkdown(manifest);
  }

  const full = await generateWikiFullContext({
    runtime: args.runtime,
    budgetChars: args.budgetChars
  });
  return format === "json" ? `${JSON.stringify(full, null, 2)}\n` : renderWikiFullMarkdown(full);
}
