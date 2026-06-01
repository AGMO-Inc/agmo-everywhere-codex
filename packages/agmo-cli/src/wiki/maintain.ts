import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  listMarkdownFiles,
  readMarkdownFile,
  type WikiRuntime,
  wikiRelativePath
} from "./runtime.js";

export type WikiIssueKind =
  | "STALE"
  | "LOW_CONFIDENCE"
  | "CONTESTED"
  | "SUPERSEDED"
  | "MISSING_FRONTMATTER"
  | "BROKEN_WIKILINK";

export type WikiIssueSeverity = "low" | "medium" | "high";

export type WikiMaintenanceIssue = {
  kind: WikiIssueKind;
  severity: WikiIssueSeverity;
  path: string;
  message: string;
};

export type WikiMaintenanceResult = {
  project: string;
  max_age_days: number;
  issue_count: number;
  issues: WikiMaintenanceIssue[];
};

const WIKILINK_RE = /\[\[([^\]]+)\]\]/gu;

function parseDate(value: string | undefined): Date | null {
  if (!value?.trim()) {
    return null;
  }
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function daysBetween(left: Date, right: Date): number {
  return Math.floor((left.getTime() - right.getTime()) / 86_400_000);
}

function resolveLinkCandidates(runtime: WikiRuntime, sourcePath: string, rawLink: string): string[] {
  const link = rawLink.split("|", 1)[0].split("#", 1)[0].trim();
  if (!link || link.endsWith("/")) {
    return [];
  }

  const mdLink = link.endsWith(".md") ? link : `${link}.md`;
  const sourceDir = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
  return [
    join(sourceDir, mdLink),
    join(runtime.vault_root, mdLink),
    join(runtime.wiki_root, mdLink),
    join(runtime.wiki_root, "projects", mdLink)
  ];
}

async function collectAuditPaths(runtime: WikiRuntime): Promise<string[]> {
  const fixed = [
    join(runtime.wiki_root, "SCHEMA.md"),
    join(runtime.wiki_root, "INDEX.md"),
    join(runtime.wiki_root, "LOG.md"),
    join(runtime.wiki_root, "projects", `${runtime.project}.md`)
  ].filter((path) => existsSync(path));
  const projectFiles = await listMarkdownFiles(join(runtime.wiki_root, "projects", runtime.project));
  const wisdomFiles = [
    `${runtime.project}/wisdom/learnings.md`,
    `${runtime.project}/wisdom/decisions.md`,
    `${runtime.project}/wisdom/issues.md`,
    "shared/wisdom/learnings.md",
    "shared/wisdom/decisions.md",
    "shared/wisdom/issues.md"
  ]
    .map((rel) => join(runtime.vault_root, rel))
    .filter((path) => existsSync(path));

  return [...new Set([...fixed, ...projectFiles, ...wisdomFiles])].sort();
}

export async function auditWiki(args: {
  runtime: WikiRuntime;
  maxAgeDays?: number;
  now?: Date;
}): Promise<WikiMaintenanceResult> {
  const maxAgeDays = args.maxAgeDays ?? 90;
  const now = args.now ?? new Date();
  const paths = await collectAuditPaths(args.runtime);
  const issues: WikiMaintenanceIssue[] = [];
  const seen = new Set<string>();
  const supersededTargets = new Set<string>();
  const pages = await Promise.all(paths.map((path) => readMarkdownFile(path)));

  const addIssue = (
    kind: WikiIssueKind,
    path: string,
    message: string,
    severity: WikiIssueSeverity
  ) => {
    const rel = wikiRelativePath(args.runtime, path);
    const key = `${kind}:${rel}:${message}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    issues.push({ kind, severity, path: rel, message });
  };

  for (const page of pages) {
    if (!page) {
      continue;
    }
    const supersedes = page.frontmatter.supersedes?.trim();
    if (supersedes) {
      supersededTargets.add(supersedes);
      supersededTargets.add(join(args.runtime.vault_root, supersedes));
      supersededTargets.add(join(page.path.slice(0, page.path.lastIndexOf("/")), supersedes));
    }
  }

  for (const page of pages) {
    if (!page) {
      continue;
    }

    const rel = wikiRelativePath(args.runtime, page.path);
    const isCore = ["SCHEMA.md", "INDEX.md", "LOG.md"].includes(page.path.split("/").at(-1) ?? "");
    const isWisdom = rel.includes("/wisdom/");
    const fm = page.frontmatter;

    if (!isCore && !isWisdom && Object.keys(fm).length === 0) {
      addIssue("MISSING_FRONTMATTER", page.path, "Page has no YAML frontmatter.", "medium");
    }

    if (supersededTargets.has(rel) || supersededTargets.has(page.path)) {
      addIssue(
        "SUPERSEDED",
        page.path,
        "Page is superseded by a newer capture; avoid injecting or relying on it.",
        "medium"
      );
    }

    if (fm.confidence?.toLowerCase() === "low") {
      addIssue("LOW_CONFIDENCE", page.path, "Low-confidence page must be verified or superseded.", "high");
    }

    if (["true", "yes"].includes(fm.contested?.toLowerCase() ?? "") || fm.contradictions) {
      addIssue(
        "CONTESTED",
        page.path,
        "Page is marked contested or has contradictions; reconcile before relying on it.",
        "high"
      );
    }

    const updated = parseDate(fm.updated ?? fm.created);
    if (updated) {
      const age = daysBetween(now, updated);
      if (age > maxAgeDays) {
        addIssue("STALE", page.path, `Page is ${age} days old; review for drift.`, "medium");
      }
    }

    for (const match of page.content.matchAll(WIKILINK_RE)) {
      const rawLink = match[1] ?? "";
      const candidates = resolveLinkCandidates(args.runtime, page.path, rawLink);
      if (candidates.length > 0 && !candidates.some((candidate) => existsSync(candidate))) {
        addIssue("BROKEN_WIKILINK", page.path, `Broken wikilink: [[${rawLink}]]`, "low");
      }
    }
  }

  issues.sort(
    (left, right) =>
      severityRank(right.severity) - severityRank(left.severity) ||
      left.kind.localeCompare(right.kind) ||
      left.path.localeCompare(right.path)
  );

  return {
    project: args.runtime.project,
    max_age_days: maxAgeDays,
    issue_count: issues.length,
    issues
  };
}

function severityRank(value: WikiIssueSeverity): number {
  return value === "high" ? 3 : value === "medium" ? 2 : 1;
}

export function renderWikiMaintenanceMarkdown(result: WikiMaintenanceResult): string {
  const lines = [
    `## LLM Wiki Maintenance (${result.project})`,
    `- Issues: ${result.issue_count}`
  ];

  if (result.issues.length === 0) {
    lines.push("- Status: clean");
  } else {
    for (const issue of result.issues) {
      lines.push(`- [${issue.severity}] ${issue.kind}: \`${issue.path}\` - ${issue.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
