import { join } from "node:path";
import type { InstallScope } from "../utils/paths.js";
import { readTextFileIfExists, writeTextFile, type WriteStatus } from "../utils/fs.js";
import { readWisdomStore, type AgmoWisdomEntry } from "../wisdom/store.js";
import type { WikiRuntime } from "./runtime.js";

export type WikiWisdomMigrationResult = {
  scope: InstallScope;
  project: string;
  dry_run: boolean;
  source_path: string;
  planned: Array<{
    kind: AgmoWisdomEntry["kind"];
    id: string;
    target_path: string;
    already_present: boolean;
  }>;
  written: Array<{
    path: string;
    status: WriteStatus;
  }>;
};

const SECTION_BY_KIND: Record<AgmoWisdomEntry["kind"], string> = {
  learn: "Learnings",
  decision: "Decisions",
  issue: "Issues"
};

const FILE_BY_KIND: Record<AgmoWisdomEntry["kind"], string> = {
  learn: "learnings.md",
  decision: "decisions.md",
  issue: "issues.md"
};

function targetPath(runtime: WikiRuntime, scope: InstallScope, kind: AgmoWisdomEntry["kind"]): string {
  const root = scope === "project" ? runtime.project : "shared";
  return join(runtime.vault_root, root, "wisdom", FILE_BY_KIND[kind]);
}

function initialWisdomFile(runtime: WikiRuntime, scope: InstallScope, kind: AgmoWisdomEntry["kind"]): string {
  const titleRoot = scope === "project" ? runtime.project : "Shared";
  return [
    "---",
    `title: "${titleRoot} Wisdom: ${SECTION_BY_KIND[kind]}"`,
    `project: "${runtime.project}"`,
    `scope: "${scope}"`,
    "source: agmo-wisdom-json-migration",
    "---",
    "",
    `# ${titleRoot} Wisdom: ${SECTION_BY_KIND[kind]}`,
    ""
  ].join("\n");
}

function renderEntry(entry: AgmoWisdomEntry): string {
  return [
    `<!-- agmo-wisdom-id:${entry.id} -->`,
    `- (${entry.created_at}) ${entry.content}`
  ].join("\n");
}

export async function migrateWisdomToWiki(args: {
  runtime: WikiRuntime;
  scope: InstallScope;
  dryRun?: boolean;
}): Promise<WikiWisdomMigrationResult> {
  const dryRun = args.dryRun ?? true;
  const store = await readWisdomStore(args.scope, args.runtime.cwd);
  const planned: WikiWisdomMigrationResult["planned"] = [];
  const byPath = new Map<string, { base: string; blocks: string[] }>();

  for (const entry of store.entries) {
    const path = targetPath(args.runtime, args.scope, entry.kind);
    const existing = await readTextFileIfExists(path);
    const marker = `agmo-wisdom-id:${entry.id}`;
    const alreadyPresent = existing?.includes(marker) ?? false;
    planned.push({
      kind: entry.kind,
      id: entry.id,
      target_path: path,
      already_present: alreadyPresent
    });

    if (alreadyPresent) {
      continue;
    }

    const current = byPath.get(path) ?? {
      base: existing ?? initialWisdomFile(args.runtime, args.scope, entry.kind),
      blocks: []
    };
    current.blocks.push(renderEntry(entry));
    byPath.set(path, current);
  }

  const written: WikiWisdomMigrationResult["written"] = [];
  if (!dryRun) {
    for (const [path, update] of byPath) {
      const content = `${update.base.trimEnd()}\n\n${update.blocks.join("\n\n")}\n`;
      written.push(await writeTextFile(path, content));
    }
  }

  return {
    scope: args.scope,
    project: args.runtime.project,
    dry_run: dryRun,
    source_path: store.path,
    planned,
    written
  };
}

export function renderWisdomMigrationMarkdown(result: WikiWisdomMigrationResult): string {
  const lines = [
    `## LLM Wiki Wisdom Migration (${result.scope})`,
    `- Project: ${result.project}`,
    `- Dry run: ${result.dry_run ? "yes" : "no"}`,
    `- Source: \`${result.source_path}\``,
    `- Entries: ${result.planned.length}`
  ];

  if (result.planned.length === 0) {
    lines.push("- Status: no wisdom entries to migrate");
  } else {
    for (const item of result.planned) {
      lines.push(
        `- ${item.kind} ${item.id}: \`${item.target_path}\`${item.already_present ? " (already present)" : ""}`
      );
    }
  }

  if (result.written.length > 0) {
    lines.push("", "### Writes");
    for (const write of result.written) {
      lines.push(`- ${write.status}: \`${write.path}\``);
    }
  }

  return `${lines.join("\n")}\n`;
}
