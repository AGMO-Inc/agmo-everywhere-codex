import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { readTextFileIfExists } from "../utils/fs.js";
import { resolveRuntimeRoot } from "../utils/paths.js";
import { resolveVaultRoot } from "../vault/runtime.js";

export type WikiRuntime = {
  cwd: string;
  vault_root: string;
  wiki_root: string;
  project: string;
};

export type WikiFrontmatter = Record<string, string>;

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/u;

export function sanitizeWikiName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[\/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ");

  if (!sanitized) {
    throw new Error("project is empty after sanitization");
  }
  if (sanitized === "." || sanitized === "..") {
    throw new Error("project cannot be a relative path segment");
  }

  return sanitized;
}

export function inferProjectName(cwd = process.cwd()): string {
  return sanitizeWikiName(basename(resolveRuntimeRoot(cwd)));
}

export async function resolveWikiRuntime(args: {
  cwd?: string;
  project?: string;
  requireVault?: boolean;
} = {}): Promise<WikiRuntime | null> {
  const cwd = resolveRuntimeRoot(args.cwd ?? process.cwd());
  const vault = await resolveVaultRoot(cwd);
  if (!vault.vault_root) {
    if (args.requireVault) {
      throw new Error("Vault not configured. Run `agmo vault config set-root <path>` or set AGMO_VAULT_ROOT.");
    }
    return null;
  }

  return {
    cwd,
    vault_root: vault.vault_root,
    wiki_root: join(vault.vault_root, ".agmo", "llm-wiki"),
    project: sanitizeWikiName(args.project ?? inferProjectName(cwd))
  };
}

export function wikiRelativePath(runtime: WikiRuntime, path: string): string {
  const rel = relative(runtime.vault_root, path).replace(/\\/g, "/");
  return rel && !rel.startsWith("..") ? rel : path;
}

export function projectCapsulePath(runtime: WikiRuntime, project = runtime.project): string {
  return join(runtime.wiki_root, "projects", `${sanitizeWikiName(project)}.md`);
}

export function projectCapturesDir(runtime: WikiRuntime, project = runtime.project): string {
  return join(runtime.wiki_root, "projects", sanitizeWikiName(project), "captures");
}

export function wisdomPath(runtime: WikiRuntime, rel: string): string {
  return join(runtime.vault_root, rel);
}

export function ensureWikiLink(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("wikilink value is empty");
  }
  return trimmed.startsWith("[[") && trimmed.endsWith("]]") ? trimmed : `[[${trimmed}]]`;
}

export function stripWikiLink(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("[[") && trimmed.endsWith("]]") ? trimmed.slice(2, -2) : trimmed;
}

export function parseFrontmatter(text: string): WikiFrontmatter {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    return {};
  }

  const result: WikiFrontmatter = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const colon = line.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/gu, "");
    if (key) {
      result[key] = value;
    }
  }
  return result;
}

export function removeFrontmatter(text: string): string {
  return text.replace(FRONTMATTER_RE, "").trim();
}

export async function readMarkdownFile(path: string): Promise<{
  path: string;
  content: string;
  frontmatter: WikiFrontmatter;
} | null> {
  const content = await readTextFileIfExists(path);
  if (content === null) {
    return null;
  }

  return {
    path,
    content,
    frontmatter: parseFrontmatter(content)
  };
}

export async function listMarkdownFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) {
    return [];
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return await listMarkdownFiles(path);
      }
      return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
    })
  );

  return nested.flat().sort();
}

export async function listRecentMarkdownFiles(dir: string): Promise<string[]> {
  const files = await listMarkdownFiles(dir);
  const withStats = await Promise.all(
    files.map(async (path) => ({ path, mtimeMs: (await stat(path)).mtimeMs }))
  );

  return withStats
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    .map((entry) => entry.path);
}

export function captureTitle(path: string, content: string, frontmatter: WikiFrontmatter): string {
  if (frontmatter.title?.trim()) {
    return frontmatter.title.trim();
  }

  const heading = content.match(/^#\s+(.+)$/mu)?.[1]?.trim();
  if (heading) {
    return heading;
  }

  return basename(path, ".md").replace(/^\[Wiki\]\s*/u, "");
}

export function truncateChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 1) {
    return value.slice(0, Math.max(0, maxChars));
  }
  return `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

export function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string" || !/^[0-9]+$/u.test(value.trim())) {
    return null;
  }
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
