import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { SessionState } from "../hooks/runtime-state.js";
import { recordSessionWisdomPersistence } from "../hooks/runtime-state.js";
import type { InstallScope } from "../utils/paths.js";
import { resolveInstallPaths } from "../utils/paths.js";
import { readTextFileIfExists, writeJsonFile, type WriteStatus } from "../utils/fs.js";

export type AgmoWisdomKind = "learn" | "decision" | "issue";

export type AgmoWisdomEntry = {
  id: string;
  kind: AgmoWisdomKind;
  content: string;
  created_at: string;
};

export type AgmoWisdomStore = {
  version: 1;
  entries: AgmoWisdomEntry[];
};

export type AgmoWisdomScopeSummary = {
  scope: InstallScope;
  path: string;
  entries: AgmoWisdomEntry[];
};

export type AgmoEffectiveWisdomSummary = {
  user: AgmoWisdomScopeSummary;
  project: AgmoWisdomScopeSummary;
  merged: AgmoWisdomEntry[];
};

const EMPTY_WISDOM_STORE: AgmoWisdomStore = {
  version: 1,
  entries: []
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeWisdomKind(value: string): AgmoWisdomKind {
  if (value === "learn" || value === "decision" || value === "issue") {
    return value;
  }

  throw new Error("wisdom kind must be learn|decision|issue");
}

function normalizeWisdomContent(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    throw new Error("wisdom content must not be empty");
  }

  return normalized;
}

function parseWisdomStore(content: string | null): AgmoWisdomStore {
  if (!content) {
    return EMPTY_WISDOM_STORE;
  }

  try {
    const parsed = JSON.parse(content) as Partial<AgmoWisdomStore>;
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries
          .map((entry) => {
            if (!entry || typeof entry !== "object") {
              return null;
            }

            const record = entry as Record<string, unknown>;
            const id = typeof record.id === "string" ? record.id.trim() : "";
            const kind =
              typeof record.kind === "string" ? normalizeWisdomKind(record.kind.trim()) : null;
            const entryContent =
              typeof record.content === "string"
                ? normalizeWisdomContent(record.content)
                : null;
            const createdAt =
              typeof record.created_at === "string" && record.created_at.trim().length > 0
                ? record.created_at.trim()
                : null;

            if (!id || !kind || !entryContent || !createdAt) {
              return null;
            }

            return {
              id,
              kind,
              content: entryContent,
              created_at: createdAt
            } satisfies AgmoWisdomEntry;
          })
          .filter((entry): entry is AgmoWisdomEntry => entry !== null)
      : [];

    return {
      version: 1,
      entries
    };
  } catch {
    return EMPTY_WISDOM_STORE;
  }
}

function sortNewestFirst(entries: AgmoWisdomEntry[]): AgmoWisdomEntry[] {
  return [...entries].sort((left, right) => right.created_at.localeCompare(left.created_at));
}

export function resolveWisdomStorePath(scope: InstallScope, cwd = process.cwd()): string {
  return join(resolveInstallPaths(scope, cwd).memoryDir, "wisdom.json");
}

export async function readWisdomStore(
  scope: InstallScope,
  cwd = process.cwd()
): Promise<AgmoWisdomScopeSummary> {
  const path = resolveWisdomStorePath(scope, cwd);
  const content = await readTextFileIfExists(path);
  const store = parseWisdomStore(content);

  return {
    scope,
    path,
    entries: sortNewestFirst(store.entries)
  };
}

export async function readEffectiveWisdom(
  cwd = process.cwd()
): Promise<AgmoEffectiveWisdomSummary> {
  const [user, project] = await Promise.all([
    readWisdomStore("user", cwd),
    readWisdomStore("project", cwd)
  ]);

  return {
    user,
    project,
    merged: sortNewestFirst([...project.entries, ...user.entries])
  };
}

export async function addWisdomEntry(args: {
  scope: InstallScope;
  kind: string;
  content: string;
  cwd?: string;
}): Promise<{
  scope: InstallScope;
  path: string;
  status: WriteStatus;
  entry: AgmoWisdomEntry;
  entry_count: number;
}> {
  const scope = args.scope;
  const cwd = args.cwd ?? process.cwd();
  const current = await readWisdomStore(scope, cwd);
  const entry: AgmoWisdomEntry = {
    id: randomUUID(),
    kind: normalizeWisdomKind(args.kind.trim()),
    content: normalizeWisdomContent(args.content),
    created_at: nowIso()
  };
  const nextEntries = sortNewestFirst([entry, ...current.entries]);
  const result = await writeJsonFile(current.path, {
    version: 1,
    entries: nextEntries
  } satisfies AgmoWisdomStore);

  return {
    scope,
    path: current.path,
    status: result.status,
    entry,
    entry_count: nextEntries.length
  };
}

export async function resetWisdomStore(args: {
  scope: InstallScope;
  cwd?: string;
}): Promise<{
  scope: InstallScope;
  path: string;
  status: WriteStatus;
  entry_count: number;
}> {
  const scope = args.scope;
  const cwd = args.cwd ?? process.cwd();
  const path = resolveWisdomStorePath(scope, cwd);
  const result = await writeJsonFile(path, EMPTY_WISDOM_STORE);

  return {
    scope,
    path,
    status: result.status,
    entry_count: 0
  };
}


export type WisdomOutcomeTrigger = "stop" | "post_tool_use_success";

type WisdomOutcomeCandidate = {
  kind: AgmoWisdomKind;
  content: string;
  signature: string;
};

function summarizeOutcomeText(value: string | undefined, maxLength = 180): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function detectOutcomeKind(sessionState: SessionState): AgmoWisdomKind | null {
  const workflow = sessionState.workflow?.trim();
  if (workflow !== "wisdom" && workflow !== "save-note" && workflow !== "vault-search") {
    return null;
  }

  const haystack = [
    sessionState.workflow_reason,
    sessionState.prompt_excerpt,
    sessionState.last_tool_summary,
    sessionState.autosave_notes?.[workflow]?.title
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();

  if (/(issue|bug|problem|incident|error|오류|이슈|버그|문제)/i.test(haystack)) {
    return "issue";
  }

  if (/(decision|decide|결정|판단)/i.test(haystack)) {
    return "decision";
  }

  return "learn";
}

function buildOutcomeCandidate(sessionState: SessionState): WisdomOutcomeCandidate | null {
  const workflow = sessionState.workflow?.trim();
  if (!workflow) {
    return null;
  }

  const kind = detectOutcomeKind(sessionState);
  if (!kind) {
    return null;
  }

  const noteRef = sessionState.autosave_notes?.[workflow];
  const title = summarizeOutcomeText(noteRef?.title);
  const toolSummary = summarizeOutcomeText(sessionState.last_tool_summary);
  const excerpt = summarizeOutcomeText(sessionState.prompt_excerpt);
  const reason = summarizeOutcomeText(sessionState.workflow_reason);
  const summary = title || toolSummary || excerpt || reason;

  if (!summary) {
    return null;
  }

  const fragments = [summary];
  for (const fragment of [toolSummary, excerpt, reason]) {
    if (fragment && fragment !== summary && !fragments.includes(fragment)) {
      fragments.push(fragment);
    }
  }
  if (noteRef?.wikilink) {
    fragments.push(noteRef.wikilink);
  }

  const content = normalizeWisdomContent(fragments.join(" — "));
  const signature = `${workflow}:${kind}:${summary}:${toolSummary ?? ""}:${noteRef?.wikilink ?? ""}`;

  return {
    kind,
    content,
    signature
  };
}

export async function persistSessionWisdomOutcome(args: {
  cwd: string;
  sessionState: SessionState;
  trigger: WisdomOutcomeTrigger;
}): Promise<{
  scope: InstallScope;
  path: string;
  status: WriteStatus;
  entry: AgmoWisdomEntry;
  entry_count: number;
  signature: string;
} | null> {
  const candidate = buildOutcomeCandidate(args.sessionState);
  if (!candidate) {
    return null;
  }

  if (args.sessionState.last_wisdom_entry_signature === candidate.signature) {
    return null;
  }

  const result = await addWisdomEntry({
    scope: "project",
    kind: candidate.kind,
    content: candidate.content,
    cwd: args.cwd
  });

  await recordSessionWisdomPersistence({
    cwd: args.cwd,
    payload: { session_id: args.sessionState.session_id },
    savedAt: args.sessionState.completed_at ?? args.sessionState.updated_at,
    signature: candidate.signature
  });

  return {
    ...result,
    signature: candidate.signature
  };
}
