import os from "node:os";
import { basename, join, resolve } from "node:path";
import { readTextFileIfExists, writeJsonFile, writeTextFile } from "../utils/fs.js";
import { resolveInstallPaths, type InstallScope } from "../utils/paths.js";

export type VaultNoteType = "plan" | "impl" | "design" | "research" | "meeting" | "memo";
export type VaultUpdateMode = "overwrite" | "append-section";

type VaultTypeSpec = {
  prefix: string;
  subdir: string;
  indexSection: string;
};

const VAULT_TYPE_SPECS: Record<VaultNoteType, VaultTypeSpec> = {
  plan: { prefix: "[Plan]", subdir: "plans", indexSection: "Plans" },
  impl: { prefix: "[Impl]", subdir: "implementations", indexSection: "Implementations" },
  design: { prefix: "[Design]", subdir: "designs", indexSection: "Designs" },
  research: { prefix: "[Research]", subdir: "research", indexSection: "Research" },
  meeting: { prefix: "[Meeting]", subdir: "meetings", indexSection: "Meetings" },
  memo: { prefix: "[Memo]", subdir: "memos", indexSection: "Memos" }
};

type AgmoRuntimeConfig = {
  vault_root?: string;
  [key: string]: unknown;
};

export type VaultScaffoldInput = {
  type: VaultNoteType;
  project: string;
  title: string;
  schema?: string;
  status?: string;
  issue?: string;
  issueType?: string;
  pr?: string;
  plan?: string;
  date?: string;
  attendees?: string[];
  aliases?: string[];
  tags?: string[];
  parent?: string;
  related?: string[];
  templateFile?: string;
  fields?: Record<string, string>;
  projectNoteWikilink?: string;
};

export type VaultProjectLayout = {
  vault_root: string;
  project: string;
  storage_mode: "project-root" | "nested-project";
  project_note_relative_path: string;
  project_note_wikilink: string;
};

async function readJsonFile<T>(path: string): Promise<T | null> {
  const content = await readTextFileIfExists(path);
  if (!content) {
    return null;
  }

  return JSON.parse(content) as T;
}

function sanitizeTitle(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[\/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ");

  if (!sanitized) {
    throw new Error("title is empty after sanitization");
  }

  return sanitized;
}

function todayIso(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function yamlList(values: string[]): string[] {
  return values.flatMap((value) => [`  - ${yamlScalar(value)}`]);
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function normalizeIssue(value: string | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function normalizeAttendees(value: string[] | undefined): string[] {
  return (value ?? []).map((entry) => entry.trim()).filter(Boolean);
}

function normalizeStringList(value: string[] | undefined): string[] {
  return (value ?? []).map((entry) => entry.trim()).filter(Boolean);
}

function normalizeFieldMap(
  value: Record<string, string> | undefined
): Record<string, string> {
  const entries = Object.entries(value ?? {})
    .map(([key, entry]) => [key.trim(), entry.trim()] as const)
    .filter(([key, entry]) => key.length > 0 && entry.length > 0);
  return Object.fromEntries(entries);
}

function ensureWikiLink(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("wikilink value is empty");
  }
  return trimmed.startsWith("[[") && trimmed.endsWith("]]") ? trimmed : `[[${trimmed}]]`;
}

function normalizeLinkReference(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("link reference is empty");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return ensureWikiLink(trimmed);
}

function defaultProjectIndexWikiPath(project: string): string {
  return `${project}/${project}`;
}

function defaultProjectIndexWikiLink(project: string): string {
  return ensureWikiLink(defaultProjectIndexWikiPath(project));
}

export function resolveVaultProjectLayout(
  vaultRoot: string,
  project: string
): VaultProjectLayout {
  const normalizedRoot = resolve(vaultRoot);
  const sanitizedProject = sanitizeTitle(project);
  const storageMode =
    sanitizeTitle(basename(normalizedRoot)) === sanitizedProject
      ? "project-root"
      : "nested-project";

  return {
    vault_root: normalizedRoot,
    project: sanitizedProject,
    storage_mode: storageMode,
    project_note_relative_path:
      storageMode === "project-root"
        ? `${sanitizedProject}.md`
        : join(sanitizedProject, `${sanitizedProject}.md`),
    project_note_wikilink:
      storageMode === "project-root"
        ? ensureWikiLink(sanitizedProject)
        : defaultProjectIndexWikiLink(sanitizedProject)
  };
}

function buildVaultNotePathInfo(input: {
  layout: VaultProjectLayout;
  type: VaultNoteType;
  title: string;
}): {
  relative_path: string;
  path: string;
  wikilink: string;
} {
  const typeSpec = resolveVaultType(input.type);
  const filename = `${typeSpec.prefix} ${sanitizeTitle(input.title)}.md`;
  const relativePath =
    input.layout.storage_mode === "project-root"
      ? join(typeSpec.subdir, filename)
      : join(input.layout.project, typeSpec.subdir, filename);
  const wikiPath = join(
    input.layout.project,
    typeSpec.subdir,
    filename.replace(/\.md$/, "")
  ).replace(/\\/g, "/");

  return {
    relative_path: relativePath,
    path: join(input.layout.vault_root, relativePath),
    wikilink: ensureWikiLink(wikiPath)
  };
}

async function resolveProjectNoteWikilink(
  project: string,
  cwd = process.cwd()
): Promise<string> {
  const vault = await resolveVaultRoot(cwd);
  if (!vault.vault_root || vault.source === "none") {
    return defaultProjectIndexWikiLink(project);
  }

  return resolveVaultProjectLayout(vault.vault_root, project).project_note_wikilink;
}

function resolveVaultType(type: string): VaultTypeSpec {
  if (type in VAULT_TYPE_SPECS) {
    return VAULT_TYPE_SPECS[type as VaultNoteType];
  }

  throw new Error(
    "type must be one of: plan, impl, design, research, meeting, memo"
  );
}

async function readAgmoConfig(path: string): Promise<AgmoRuntimeConfig> {
  return (await readJsonFile<AgmoRuntimeConfig>(path)) ?? {};
}

export async function resolveVaultRoot(
  cwd = process.cwd()
): Promise<{
  vault_root: string | null;
  source: "env" | "project" | "user" | "none";
  checked_paths: string[];
}> {
  if (process.env.AGMO_VAULT_ROOT?.trim()) {
    return {
      vault_root: resolve(process.env.AGMO_VAULT_ROOT),
      source: "env",
      checked_paths: []
    };
  }

  const projectConfigPath = resolveInstallPaths("project", cwd).agmoConfigFile;
  const userConfigPath = resolveInstallPaths("user", cwd).agmoConfigFile;
  const checkedPaths = [projectConfigPath, userConfigPath];

  const projectConfig = await readAgmoConfig(projectConfigPath);
  if (typeof projectConfig.vault_root === "string" && projectConfig.vault_root.trim()) {
    return {
      vault_root: resolve(projectConfig.vault_root),
      source: "project",
      checked_paths: checkedPaths
    };
  }

  const userConfig = await readAgmoConfig(userConfigPath);
  if (typeof userConfig.vault_root === "string" && userConfig.vault_root.trim()) {
    return {
      vault_root: resolve(userConfig.vault_root),
      source: "user",
      checked_paths: checkedPaths
    };
  }

  return {
    vault_root: null,
    source: "none",
    checked_paths: checkedPaths
  };
}

export async function setVaultRoot(
  path: string,
  scope: InstallScope,
  cwd = process.cwd()
): Promise<{
  scope: InstallScope;
  vault_root: string;
  config_path: string;
}> {
  const normalized = resolve(path);
  const configPath = resolveInstallPaths(scope, cwd).agmoConfigFile;
  const existing = await readAgmoConfig(configPath);

  await writeJsonFile(configPath, {
    ...existing,
    vault_root: normalized,
    updated_at: new Date().toISOString()
  });

  return {
    scope,
    vault_root: normalized,
    config_path: configPath
  };
}

function ensureMarkdownSection(content: string, sectionName: string): string {
  const heading = `## ${sectionName}`;
  if (content.includes(heading)) {
    return content;
  }

  const normalized = content.trimEnd();
  if (!normalized) {
    return `${heading}\n`;
  }

  return `${normalized}\n\n${heading}\n`;
}

function appendUniqueSectionLine(
  content: string,
  sectionName: string,
  line: string
): { content: string; updated: boolean } {
  const normalized = ensureMarkdownSection(content, sectionName);
  const lines = normalized.split("\n");
  const heading = `## ${sectionName}`;
  const sectionIndex = lines.findIndex((entry) => entry.trim() === heading);

  if (sectionIndex < 0) {
    return { content: normalized, updated: false };
  }

  let insertIndex = lines.length;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      insertIndex = index;
      break;
    }
  }

  const existingSectionLines = lines
    .slice(sectionIndex + 1, insertIndex)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (existingSectionLines.includes(line.trim())) {
    return { content: normalized, updated: false };
  }

  const nextLines = [...lines];
  const needsSpacer =
    insertIndex > sectionIndex + 1 && nextLines[insertIndex - 1].trim().length > 0;
  const payload = needsSpacer ? ["", line] : [line];
  nextLines.splice(insertIndex, 0, ...payload);

  return {
    content: `${nextLines.join("\n").replace(/\n+$/, "")}\n`,
    updated: true
  };
}

function appendMarkdownSectionBlock(
  content: string,
  sectionName: string,
  block: string,
  maxEntries?: number
): string {
  const normalized = ensureMarkdownSection(content, sectionName).replace(/\n+$/, "");
  const lines = normalized.split("\n");
  const heading = `## ${sectionName}`;
  const sectionIndex = lines.findIndex((entry) => entry.trim() === heading);

  if (sectionIndex < 0) {
    return `${normalized}\n\n${heading}\n\n${block.trim()}\n`;
  }

  let insertIndex = lines.length;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      insertIndex = index;
      break;
    }
  }

  const existingSectionLines = lines.slice(sectionIndex + 1, insertIndex).join("\n").trim();
  const existingBlocks = existingSectionLines
    ? existingSectionLines
        .split(/(?=^###\s+)/m)
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
  const nextBlocks = [...existingBlocks, block.trim()].filter(Boolean);
  const boundedBlocks =
    typeof maxEntries === "number" && Number.isFinite(maxEntries) && maxEntries > 0
      ? nextBlocks.slice(-maxEntries)
      : nextBlocks;

  const nextLines = [...lines.slice(0, sectionIndex + 1)];
  if (boundedBlocks.length > 0) {
    nextLines.push("");
    nextLines.push(...boundedBlocks.flatMap((entry, index) => (index === 0 ? [entry] : ["", entry])));
    nextLines.push("");
  }
  if (insertIndex < lines.length) {
    nextLines.push(...lines.slice(insertIndex));
  }

  return `${nextLines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "")}\n`;
}

function buildProjectIndexStub(project: string): string {
  const today = todayIso();
  return [
    "---",
    `type: ${yamlScalar("project-index")}`,
    `project: ${yamlScalar(project)}`,
    `created: ${yamlScalar(today)}`,
    `updated: ${yamlScalar(today)}`,
    "tags:",
    ...yamlList(["project", project]),
    "---",
    "",
    `# ${project}`,
    "",
    "## Plans",
    "",
    "## Implementations",
    "",
    "## Designs",
    "",
    "## Research",
    "",
    "## Meetings",
    "",
    "## Memos",
    ""
  ].join("\n");
}

export function buildVaultNoteScaffold(input: VaultScaffoldInput): {
  title: string;
  content: string;
} {
  const type = input.type;
  const project = sanitizeTitle(input.project);
  const title = sanitizeTitle(input.title);
  const created = todayIso();
  const issue = normalizeIssue(input.issue);
  const pr = normalizeIssue(input.pr);
  const attendees = normalizeAttendees(input.attendees);
  const aliases = Array.from(new Set([title, ...normalizeStringList(input.aliases)]));
  const tags = Array.from(
    new Set([
      type,
      project,
      `type/${type}`,
      `project/${project}`,
      ...normalizeStringList(input.tags)
    ])
  );
  const schema = input.schema?.trim() || null;
  const extraFields = normalizeFieldMap(input.fields);
  const projectNote = input.projectNoteWikilink?.trim()
    ? ensureWikiLink(input.projectNoteWikilink)
    : defaultProjectIndexWikiLink(project);
  const implicitParent = type === "impl" && input.plan ? input.plan : undefined;
  const parent = input.parent?.trim() ? ensureWikiLink(input.parent) : implicitParent?.trim() ? ensureWikiLink(implicitParent) : null;
  const related = Array.from(
    new Set(
      normalizeStringList(input.related).map((entry) => normalizeLinkReference(entry))
    )
  ).filter((entry) => entry !== parent);

  const frontmatter: string[] = [
    "---",
    `type: ${yamlScalar(type)}`,
    `project: ${yamlScalar(project)}`,
    `project_note: ${yamlScalar(projectNote)}`
  ];
  if (schema) {
    frontmatter.push(`schema: ${yamlScalar(schema)}`);
  }
  const body: string[] = [`# ${title}`, "", `> Project Index: ${projectNote}`];

  if (parent) {
    frontmatter.push(`parent: ${yamlScalar(parent)}`);
    body.push(`> Parent: ${parent}`);
  }

  if (related.length > 0) {
    frontmatter.push("related:");
    frontmatter.push(...yamlList(related));
  }

  body.push("");

  frontmatter.push("aliases:");
  frontmatter.push(...yamlList(aliases));

  switch (type) {
    case "plan": {
      frontmatter.push(`issue: ${issue ? yamlScalar(issue) : "null"}`);
      frontmatter.push(`issue-type: ${yamlScalar(input.issueType ?? "feature")}`);
      frontmatter.push(`status: ${yamlScalar(input.status ?? "draft")}`);
      frontmatter.push(`created: ${yamlScalar(created)}`);
      frontmatter.push(`updated: ${yamlScalar(created)}`);
      frontmatter.push("tags:");
      frontmatter.push(...yamlList(tags));
      body.push(
        "## Context",
        "",
        "{background, user request, or problem statement}",
        "",
        "## Goals",
        "",
        "- [ ] {goal 1}",
        "- [ ] {goal 2}",
        "",
        "## Plan",
        "",
        "1. {step 1}",
        "2. {step 2}",
        "",
        "## Risks / Notes",
        "",
        "- {risk or open question}",
        "",
        "## Related Links",
        "",
        `- Project Index: ${projectNote}`,
        ...(parent ? [`- Parent: ${parent}`] : []),
        ...(related.length > 0 ? related.map((entry) => `- ${entry}`) : ["- {related note or link}"])
      );
      break;
    }
    case "impl": {
      frontmatter.push(`issue: ${issue ? yamlScalar(issue) : "null"}`);
      frontmatter.push(`pr: ${pr ? yamlScalar(pr) : "null"}`);
      frontmatter.push(`plan: ${input.plan ? yamlScalar(ensureWikiLink(input.plan)) : "null"}`);
      frontmatter.push(`status: ${yamlScalar(input.status ?? "in-progress")}`);
      frontmatter.push(`created: ${yamlScalar(created)}`);
      frontmatter.push(`updated: ${yamlScalar(created)}`);
      frontmatter.push("tags:");
      frontmatter.push(...yamlList(tags));
      if (input.plan) {
        body.push(`> Plan: ${ensureWikiLink(input.plan)}`, "");
      }
      body.push(
        "## Implementation Summary",
        "",
        "{what was implemented and why}",
        "",
        "## Changed Files",
        "",
        "| File | Change |",
        "|------|--------|",
        "| `path/to/file` | {summary} |",
        "",
        "## Key Implementation Details",
        "",
        "{important logic, patterns, tradeoffs}",
        "",
        "## Design Decisions",
        "",
        "{notable decisions and rationale}",
        "",
        "## Verification Results",
        "",
        "- {build/test result}",
        "",
        "## Related Links",
        "",
        `- Project Index: ${projectNote}`,
        ...(parent ? [`- Parent: ${parent}`] : []),
        ...(related.length > 0 ? related.map((entry) => `- ${entry}`) : ["- {related note or link}"])
      );
      break;
    }
    case "design": {
      frontmatter.push(`status: ${yamlScalar(input.status ?? "draft")}`);
      frontmatter.push(`created: ${yamlScalar(created)}`);
      frontmatter.push(`updated: ${yamlScalar(created)}`);
      frontmatter.push("tags:");
      frontmatter.push(...yamlList(tags));
      body.push(
        "## Overview",
        "",
        "{design background and purpose}",
        "",
        "## Details",
        "",
        "{requirements, structure, flows, tradeoffs}",
        "",
        "## Decisions",
        "",
        "{finalized decisions}",
        "",
        "## Related Links",
        "",
        `- Project Index: ${projectNote}`,
        ...(parent ? [`- Parent: ${parent}`] : []),
        ...(related.length > 0 ? related.map((entry) => `- ${entry}`) : ["- {related note or link}"]),
        "",
        "## References",
        "",
        "{links, files, sources}"
      );
      break;
    }
    case "research": {
      frontmatter.push(`status: ${yamlScalar(input.status ?? "draft")}`);
      frontmatter.push(`created: ${yamlScalar(created)}`);
      frontmatter.push(`updated: ${yamlScalar(created)}`);
      frontmatter.push("tags:");
      frontmatter.push(...yamlList(tags));
      body.push(
        "## Background",
        "",
        "{research motivation and scope}",
        "",
        "## Findings",
        "",
        "{comparisons, experiments, notes}",
        "",
        "## Conclusion / Recommendation",
        "",
        "{summary and recommendation}",
        "",
        "## Related Links",
        "",
        `- Project Index: ${projectNote}`,
        ...(parent ? [`- Parent: ${parent}`] : []),
        ...(related.length > 0 ? related.map((entry) => `- ${entry}`) : ["- {related note or link}"]),
        "",
        "## References",
        "",
        "{docs, URLs, sources}"
      );
      break;
    }
    case "meeting": {
      frontmatter.push(`date: ${yamlScalar(input.date ?? created)}`);
      if (attendees.length > 0) {
        frontmatter.push("attendees:");
        frontmatter.push(...yamlList(attendees));
      } else {
        frontmatter.push("attendees: []");
      }
      frontmatter.push(`created: ${yamlScalar(created)}`);
      frontmatter.push(`updated: ${yamlScalar(created)}`);
      frontmatter.push("tags:");
      frontmatter.push(...yamlList(tags));
      body.push(
        "## Agenda",
        "",
        "{meeting agenda}",
        "",
        "## Discussion",
        "",
        "{main discussion points}",
        "",
        "## Decisions",
        "",
        "{decisions made}",
        "",
        "## Action Items",
        "",
        "- [ ] {action item}",
        "",
        "## Related Links",
        "",
        `- Project Index: ${projectNote}`,
        ...(parent ? [`- Parent: ${parent}`] : []),
        ...(related.length > 0 ? related.map((entry) => `- ${entry}`) : ["- {related note or link}"])
      );
      break;
    }
    case "memo": {
      frontmatter.push(`created: ${yamlScalar(created)}`);
      frontmatter.push(`updated: ${yamlScalar(created)}`);
      frontmatter.push("tags:");
      frontmatter.push(...yamlList(tags));
      body.push(
        "{free-form memo content}",
        "",
        "## Related Links",
        "",
        `- Project Index: ${projectNote}`,
        ...(parent ? [`- Parent: ${parent}`] : []),
        ...(related.length > 0 ? related.map((entry) => `- ${entry}`) : ["- {related note or link}"])
      );
      break;
    }
  }

  for (const [key, value] of Object.entries(extraFields)) {
    frontmatter.push(`${key}: ${yamlScalar(value)}`);
  }

  frontmatter.push("---", "");
  return {
    title,
    content: `${frontmatter.join("\n")}${body.join("\n")}\n`
  };
}

function splitFrontmatter(content: string): {
  frontmatter: string;
  body: string;
} {
  const lines = content.split("\n");
  if (lines[0] !== "---") {
    return { frontmatter: "", body: content };
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closingIndex < 0) {
    return { frontmatter: "", body: content };
  }

  return {
    frontmatter: `${lines.slice(0, closingIndex + 1).join("\n")}\n`,
    body: `${lines.slice(closingIndex + 1).join("\n").replace(/^\n/, "")}`
  };
}

function renderTemplateString(
  template: string,
  values: Record<string, string>
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    return values[key] ?? "";
  });
}

export async function renderVaultNoteScaffold(
  input: VaultScaffoldInput,
  cwd = process.cwd()
): Promise<{
  title: string;
  content: string;
}> {
  const projectNoteWikilink =
    input.projectNoteWikilink?.trim() ?? (await resolveProjectNoteWikilink(input.project, cwd));
  const base = buildVaultNoteScaffold({
    ...input,
    projectNoteWikilink
  });
  if (!input.templateFile?.trim()) {
    return base;
  }

  const templatePath = resolve(input.templateFile);
  const templateContent = await readTextFileIfExists(templatePath);
  if (templateContent === null) {
    throw new Error(`template file not found: ${input.templateFile}`);
  }

  const { frontmatter, body } = splitFrontmatter(base.content);
  const sanitizedTitle = sanitizeTitle(input.title);
  const sanitizedProject = sanitizeTitle(input.project);
  const extraFields = normalizeFieldMap(input.fields);
  const effectiveParent =
    input.parent?.trim() ? ensureWikiLink(input.parent) : input.plan?.trim() ? ensureWikiLink(input.plan) : "";
  const related = normalizeStringList(input.related).map((entry) => normalizeLinkReference(entry));
  const values: Record<string, string> = {
    title: sanitizedTitle,
    project: sanitizedProject,
    type: input.type,
    schema: input.schema?.trim() ?? "",
    frontmatter,
    body,
    project_note: projectNoteWikilink,
    plan: input.plan ? ensureWikiLink(input.plan) : "",
    parent: effectiveParent,
    related_lines: related.map((entry) => `- ${entry}`).join("\n"),
    aliases_lines: normalizeStringList(input.aliases).map((entry) => `- ${entry}`).join("\n"),
    tags_lines: normalizeStringList(input.tags).map((entry) => `- ${entry}`).join("\n"),
    created: todayIso(),
    updated: todayIso()
  };
  for (const [key, value] of Object.entries(extraFields)) {
    values[key] = value;
  }

  const rendered = renderTemplateString(templateContent, values);
  const finalContent = templateContent.includes("{{frontmatter}}")
    ? rendered
    : `${frontmatter}${rendered.replace(/^\n+/, "")}`;

  return {
    title: base.title,
    content: finalContent.endsWith("\n") ? finalContent : `${finalContent}\n`
  };
}

async function saveVaultContent(
  input: {
    type: VaultNoteType;
    project: string;
    title: string;
    content: string;
    index?: boolean;
  },
  cwd = process.cwd()
): Promise<{
  vault_root: string;
  source: "env" | "project" | "user";
  project: string;
  type: VaultNoteType;
  title: string;
  path: string;
  relative_path: string;
  wikilink: string;
  project_wikilink: string;
  created: boolean;
  duplicate: boolean;
  index_updated: boolean;
  index_path?: string;
}> {
  const typeSpec = resolveVaultType(input.type);
  const project = sanitizeTitle(input.project);
  const title = sanitizeTitle(input.title);
  const vault = await resolveVaultRoot(cwd);
  if (!vault.vault_root || vault.source === "none") {
    throw new Error(
      "vault root is not configured. Set AGMO_VAULT_ROOT or run `agmo vault config set-root <path>`."
    );
  }

  const layout = resolveVaultProjectLayout(vault.vault_root, project);
  const location = buildVaultNotePathInfo({
    layout,
    type: input.type,
    title
  });
  const existing = await readTextFileIfExists(location.path);

  if (existing !== null) {
    return {
      vault_root: vault.vault_root,
      source: vault.source,
      project,
      type: input.type,
      title,
      path: location.path,
      relative_path: location.relative_path,
      wikilink: location.wikilink,
      project_wikilink: layout.project_note_wikilink,
      created: false,
      duplicate: true,
      index_updated: false
    };
  }

  await writeTextFile(
    location.path,
    input.content.endsWith("\n") ? input.content : `${input.content}\n`
  );

  let indexUpdated = false;
  let indexPath: string | undefined;
  if (input.index) {
    indexPath = join(vault.vault_root, layout.project_note_relative_path);
    const indexExisting =
      (await readTextFileIfExists(indexPath)) ?? buildProjectIndexStub(project);
    const nextIndex = appendUniqueSectionLine(
      indexExisting,
      typeSpec.indexSection,
      `- ${location.wikilink}`
    );
    await writeTextFile(indexPath, nextIndex.content);
    indexUpdated = nextIndex.updated;
  }

  return {
    vault_root: vault.vault_root,
    source: vault.source,
    project,
    type: input.type,
    title,
    path: location.path,
    relative_path: location.relative_path,
    wikilink: location.wikilink,
    project_wikilink: layout.project_note_wikilink,
    created: true,
    duplicate: false,
    index_updated: indexUpdated,
    ...(indexPath ? { index_path: indexPath } : {})
  };
}

async function upsertVaultContent(
  input: {
    type: VaultNoteType;
    project: string;
    title: string;
    content: string;
    index?: boolean;
    update_mode?: VaultUpdateMode;
    append_section_title?: string;
    append_content?: string;
    append_max_entries?: number;
  },
  cwd = process.cwd()
): Promise<{
  vault_root: string;
  source: "env" | "project" | "user";
  project: string;
  type: VaultNoteType;
  title: string;
  path: string;
  relative_path: string;
  wikilink: string;
  project_wikilink: string;
  created: boolean;
  updated: boolean;
  index_updated: boolean;
  index_path?: string;
}> {
  const typeSpec = resolveVaultType(input.type);
  const project = sanitizeTitle(input.project);
  const title = sanitizeTitle(input.title);
  const vault = await resolveVaultRoot(cwd);
  if (!vault.vault_root || vault.source === "none") {
    throw new Error(
      "vault root is not configured. Set AGMO_VAULT_ROOT or run `agmo vault config set-root <path>`."
    );
  }

  const layout = resolveVaultProjectLayout(vault.vault_root, project);
  const location = buildVaultNotePathInfo({
    layout,
    type: input.type,
    title
  });
  const existing = await readTextFileIfExists(location.path);
  const baseContent = input.content.endsWith("\n") ? input.content : `${input.content}\n`;
  const nextContent =
    existing !== null &&
    input.update_mode === "append-section" &&
    input.append_content?.trim()
      ? appendMarkdownSectionBlock(
          existing,
          input.append_section_title ?? "Auto Checkpoints",
          input.append_content,
          input.append_max_entries
        )
      : baseContent;

  await writeTextFile(location.path, nextContent);

  let indexUpdated = false;
  let indexPath: string | undefined;
  if (input.index) {
    indexPath = join(vault.vault_root, layout.project_note_relative_path);
    const indexExisting =
      (await readTextFileIfExists(indexPath)) ?? buildProjectIndexStub(project);
    const nextIndex = appendUniqueSectionLine(
      indexExisting,
      typeSpec.indexSection,
      `- ${location.wikilink}`
    );
    await writeTextFile(indexPath, nextIndex.content);
    indexUpdated = nextIndex.updated;
  }

  return {
    vault_root: vault.vault_root,
    source: vault.source,
    project,
    type: input.type,
    title,
    path: location.path,
    relative_path: location.relative_path,
    wikilink: location.wikilink,
    project_wikilink: layout.project_note_wikilink,
    created: existing === null,
    updated: existing !== null,
    index_updated: indexUpdated,
    ...(indexPath ? { index_path: indexPath } : {})
  };
}

export async function saveVaultNote(
  input: {
    type: VaultNoteType;
    project: string;
    title: string;
    file: string;
    index?: boolean;
  },
  cwd = process.cwd()
): Promise<{
  vault_root: string;
  source: "env" | "project" | "user";
  project: string;
  type: VaultNoteType;
  title: string;
  path: string;
  relative_path: string;
  wikilink: string;
  project_wikilink: string;
  created: boolean;
  duplicate: boolean;
  index_updated: boolean;
  index_path?: string;
}> {
  const fileContent = await readTextFileIfExists(resolve(input.file));

  if (fileContent === null) {
    throw new Error(`content file not found: ${input.file}`);
  }

  return await saveVaultContent(
    {
      type: input.type,
      project: input.project,
      title: input.title,
      content: fileContent,
      index: input.index
    },
    cwd
  );
}

export async function saveVaultTextNote(
  input: {
    type: VaultNoteType;
    project: string;
    title: string;
    content: string;
    index?: boolean;
  },
  cwd = process.cwd()
): Promise<{
  vault_root: string;
  source: "env" | "project" | "user";
  project: string;
  type: VaultNoteType;
  title: string;
  path: string;
  relative_path: string;
  wikilink: string;
  project_wikilink: string;
  created: boolean;
  duplicate: boolean;
  index_updated: boolean;
  index_path?: string;
}> {
  return await saveVaultContent(input, cwd);
}

export async function upsertVaultTextNote(
  input: {
    type: VaultNoteType;
    project: string;
    title: string;
    content: string;
    index?: boolean;
    update_mode?: VaultUpdateMode;
    append_section_title?: string;
    append_content?: string;
    append_max_entries?: number;
  },
  cwd = process.cwd()
): Promise<{
  vault_root: string;
  source: "env" | "project" | "user";
  project: string;
  type: VaultNoteType;
  title: string;
  path: string;
  relative_path: string;
  wikilink: string;
  project_wikilink: string;
  created: boolean;
  updated: boolean;
  index_updated: boolean;
  index_path?: string;
}> {
  return await upsertVaultContent(input, cwd);
}

export async function appendVaultSectionLine(
  input: {
    relative_path: string;
    section: string;
    line: string;
  },
  cwd = process.cwd()
): Promise<{
  path: string;
  relative_path: string;
  updated: boolean;
}> {
  const vault = await resolveVaultRoot(cwd);
  if (!vault.vault_root || vault.source === "none") {
    throw new Error(
      "vault root is not configured. Set AGMO_VAULT_ROOT or run `agmo vault config set-root <path>`."
    );
  }

  const targetPath = join(vault.vault_root, input.relative_path);
  const existing = await readTextFileIfExists(targetPath);
  if (existing === null) {
    throw new Error(`vault note not found: ${input.relative_path}`);
  }

  const next = appendUniqueSectionLine(existing, input.section, input.line);
  await writeTextFile(targetPath, next.content);

  return {
    path: targetPath,
    relative_path: input.relative_path,
    updated: next.updated
  };
}

export async function createVaultNote(
  input: VaultScaffoldInput & {
    index?: boolean;
  },
  cwd = process.cwd()
): Promise<{
  scaffold: {
    title: string;
    content: string;
  };
  vault: {
    vault_root: string;
    source: "env" | "project" | "user";
    project: string;
    type: VaultNoteType;
    title: string;
    path: string;
    relative_path: string;
    wikilink: string;
    project_wikilink: string;
    created: boolean;
    duplicate: boolean;
    index_updated: boolean;
    index_path?: string;
  };
}> {
  const scaffold = await renderVaultNoteScaffold(input, cwd);
  const vault = await saveVaultContent(
    {
      type: input.type,
      project: input.project,
      title: scaffold.title,
      content: scaffold.content,
      index: input.index
    },
    cwd
  );
  return { scaffold, vault };
}

export function defaultUserVaultConfigPath(): string {
  return join(os.homedir(), ".agmo", "config.json");
}
