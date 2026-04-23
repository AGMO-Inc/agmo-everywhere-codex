import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveVaultAutosavePolicy } from "../config/runtime.js";
import {
  recordSessionAutosave,
  type SessionState,
  type SessionWorkflowNoteRef,
  type VerificationRecord
} from "../hooks/runtime-state.js";
import { readTextFileIfExists } from "../utils/fs.js";
import {
  agmoCliTemplateCandidatePaths,
  resolveRuntimeRoot
} from "../utils/paths.js";
import {
  appendVaultSectionLine,
  resolveVaultRoot,
  resolveVaultProjectLayout,
  upsertVaultTextNote,
  type VaultNoteType
} from "./runtime.js";
import { renderTemplateString } from "./template-format.js";

export type SessionCheckpointTrigger =
  | "workflow_change"
  | "post_tool_use_success"
  | "stop";

const execFileAsync = promisify(execFile);

const CHECKPOINT_VAULT_TYPE_PATHS: Record<
  VaultNoteType,
  { prefix: string; subdir: string }
> = {
  plan: { prefix: "[Plan]", subdir: "plans" },
  impl: { prefix: "[Impl]", subdir: "implementations" },
  design: { prefix: "[Design]", subdir: "designs" },
  research: { prefix: "[Research]", subdir: "research" },
  meeting: { prefix: "[Meeting]", subdir: "meetings" },
  memo: { prefix: "[Memo]", subdir: "memos" }
};

type NoteRelations = {
  parent: SessionWorkflowNoteRef | null;
  related: SessionWorkflowNoteRef[];
};

type VerificationSummary = {
  label: string;
  outcome: string;
  recordedAt?: string;
};

function isoDate(value: string | undefined): string {
  const now = value ? new Date(value) : new Date();
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function inferDefaultCheckpointType(workflow: string | undefined): VaultNoteType {
  switch (workflow) {
    case "brainstorming":
      return "design";
    case "plan":
      return "plan";
    case "wisdom":
    case "vault-search":
      return "research";
    case "verify":
      return "memo";
    case "execute":
    case "save-note":
    default:
      return "impl";
  }
}

function shortSessionId(sessionId: string): string {
  const normalized = sessionId.replace(/[^a-zA-Z0-9_-]+/g, "");
  return normalized.slice(-8) || "session";
}

function cleanTitleSegment(value: string): string {
  const normalized = value
    .replace(/\s+/g, " ")
    .replace(/[\/\\:*?"<>|]/g, "")
    .replace(/^[`"'“”‘’\s]+|[`"'“”‘’\s]+$/g, "")
    .replace(/^\$[a-z-]+\s+/i, "")
    .replace(/^(응|음|그래|좋아|오케이|okay|ok|그럼|그러자|자)\s+/iu, "")
    .replace(/^(일단|우선|특히)\s+/u, "")
    .replace(
      /\s*(진행해줘|진행해보자|읽고 구현 시작하자|구현 시작하자|읽자|보자|봐바|봐봐|해줘|해보자|부탁해|please)\.?$/iu,
      ""
    )
    .trim();

  if (
    /you are worker-\d+/iu.test(normalized) ||
    /read the inbox file at/iu.test(normalized) ||
    /^agmo:\s+new inbox message/iu.test(normalized)
  ) {
    return "";
  }

  if (/\[(memo|plan|impl|design|research|meeting)\]/i.test(normalized)) {
    const trimmed =
      normalized
        .split(/\s+-\s+/u)[0]
        ?.replace(/^\[(memo|plan|impl|design|research|meeting)\]\s*/iu, "")
        .replace(/\]$/u, "")
        .trim() ?? normalized;
    return trimmed;
  }

  return normalized;
}

function titleCandidateScore(value: string): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = Math.min(value.length, 80);
  if (
    /you are worker-\d+/iu.test(value) ||
    /read the inbox file at/iu.test(value) ||
    /^agmo:\s+new inbox message/iu.test(value)
  ) {
    score -= 120;
  }
  if (/\[(memo|plan|impl|design|research|meeting)\]/i.test(value)) {
    score += 24;
  }
  if (/^(진행|응|좋아|오케이|okay|ok)$/iu.test(value)) {
    score -= 40;
  }
  if (value.length < 6) {
    score -= 12;
  }
  return score;
}

function isWeakTitle(value: string | null | undefined): boolean {
  if (!value) {
    return true;
  }

  return titleCandidateScore(value) < 12;
}

function stripDerivedDecorators(value: string): string {
  return value
    .replace(/^\d{4}-\d{2}-\d{2}\s+/u, "")
    .replace(/\s+\([0-9]+\)$/u, "")
    .replace(/\s+[a-z0-9]{8}$/iu, "")
    .trim();
}

function relatedTitleCandidate(noteType: VaultNoteType, sessionState: SessionState): string | null {
  const notes = sessionState.autosave_notes ?? {};
  const candidate =
    noteType === "impl"
      ? notes.plan?.title ?? notes.brainstorming?.title
      : noteType === "plan"
        ? notes.brainstorming?.title
        : null;
  if (!candidate) {
    return null;
  }

  const normalized = cleanTitleSegment(stripDerivedDecorators(candidate));
  return isWeakTitle(normalized) ? null : normalized;
}

function looksLikeWorkerBootstrapText(value: string | null | undefined): boolean {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }

  return (
    /you are worker-\d+/iu.test(normalized) ||
    /read the inbox file at/iu.test(normalized) ||
    /^agmo:\s+new inbox message/iu.test(normalized) ||
    /current task summary:/iu.test(normalized)
  );
}

function normalizePromptExcerptForBody(value: string | undefined): string {
  const raw = (value ?? "").replace(/\r\n?/g, "\n").trim();
  if (!raw) {
    return "";
  }

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^agmo:\s+new inbox message/iu.test(line));
  const normalized = lines.join("\n").trim();
  return looksLikeWorkerBootstrapText(normalized) ? "" : normalized;
}

function resolveCheckpointFocus(noteType: VaultNoteType, sessionState: SessionState): string {
  return (
    normalizeTitleTopic(normalizePromptExcerptForBody(sessionState.prompt_excerpt)) ??
    normalizeTitleTopic(sessionState.prompt_excerpt) ??
    relatedTitleCandidate(noteType, sessionState) ??
    `Agmo ${sessionState.workflow ?? noteType} checkpoint`
  );
}

function formatLatestSignal(sessionState: SessionState): string {
  if (sessionState.last_tool_summary?.trim()) {
    return sessionState.last_tool_summary.trim();
  }
  if (sessionState.last_tool_name?.trim() && sessionState.last_tool_status?.trim()) {
    return `${sessionState.last_tool_name.trim()} (${sessionState.last_tool_status.trim()})`;
  }
  return sessionState.last_event ?? "n/a";
}

function renderQuotedLines(value: string | undefined, fallback: string): string[] {
  const normalized = normalizePromptExcerptForBody(value);
  const lines = normalized
    ? normalized
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
  return lines.length > 0 ? lines.map((line) => `> ${line}`) : [`> ${fallback}`];
}

function buildDesignCheckpointSummary(
  sessionState: SessionState,
  trigger: SessionCheckpointTrigger
): string[] {
  const focus = resolveCheckpointFocus("design", sessionState);
  const nextStep =
    trigger === "stop"
      ? "Hand this design note to the planning lane and preserve the linked follow-up note."
      : "Continue the design lane until the tradeoffs are clear enough to hand off to plan.";

  return [
    "## Design Brief",
    "",
    `${focus} is the active design topic captured in this checkpoint.`,
    "",
    "## Decision Drivers",
    "",
    `- Focus: ${focus}`,
    `- Context: ${sessionState.workflow_reason ?? "n/a"}`,
    `- Latest Signal: ${formatLatestSignal(sessionState)}`,
    `- Workflow State: ${sessionState.workflow ?? "unknown"} / ${sessionState.last_event}`,
    "",
    "## Recommended Next Step",
    "",
    `- ${nextStep}`,
    "",
    "## Captured Request",
    "",
    ...renderQuotedLines(sessionState.prompt_excerpt, "{worker bootstrap prompt omitted}"),
    "",
    "## Notes",
    "",
    `- Auto-saved by Agmo native ${trigger} checkpoint.`
  ];
}

function buildResearchCheckpointSummary(
  sessionState: SessionState,
  trigger: SessionCheckpointTrigger
): string[] {
  const focus = resolveCheckpointFocus("research", sessionState);
  const followUp =
    trigger === "stop"
      ? "Carry these findings into the downstream plan or implementation note and keep the references linked."
      : "Continue retrieval and synthesis until the evidence is strong enough to support a concrete recommendation.";

  return [
    "## Research Brief",
    "",
    `${focus} is the current research topic preserved in this checkpoint.`,
    "",
    "## Findings Snapshot",
    "",
    `- Topic: ${focus}`,
    `- Retrieval Context: ${sessionState.workflow_reason ?? "n/a"}`,
    `- Latest Signal: ${formatLatestSignal(sessionState)}`,
    `- Workflow State: ${sessionState.workflow ?? "unknown"} / ${sessionState.last_event}`,
    "",
    "## Recommended Follow-up",
    "",
    `- ${followUp}`,
    "",
    "## Captured Request",
    "",
    ...renderQuotedLines(sessionState.prompt_excerpt, "{worker bootstrap prompt omitted}"),
    "",
    "## Notes",
    "",
    `- Auto-saved by Agmo native ${trigger} checkpoint.`
  ];
}

export function normalizeTitleTopic(value: string | undefined): string | null {
  const normalized = (value ?? "")
    .replace(/\s+/g, " ")
    .replace(/[\/\\:*?"<>|]/g, "")
    .trim();
  if (!normalized) {
    return null;
  }

  const rawCandidates = [normalized, ...normalized.split(/\s*(?:<-|->|=>|→|\|)\s*/g)]
    .flatMap((entry) => entry.split(/\s*[!?]\s*/g))
    .map((entry) => cleanTitleSegment(entry))
    .filter(Boolean);
  const best = rawCandidates.sort((left, right) => titleCandidateScore(right) - titleCandidateScore(left))[0];
  if (!best || isWeakTitle(best)) {
    return null;
  }

  return best.length <= 72 ? best : `${best.slice(0, 69).trimEnd()}...`;
}

function resolveCheckpointType(
  workflow: string | undefined,
  workflowTypes: Record<string, string>
): VaultNoteType {
  const mapped = workflow ? workflowTypes[workflow] : undefined;
  return mapped === "plan" ||
    mapped === "impl" ||
    mapped === "design" ||
    mapped === "research" ||
    mapped === "meeting" ||
    mapped === "memo"
    ? mapped
    : inferDefaultCheckpointType(workflow);
}

function buildDefaultTitle(args: {
  sessionState: SessionState;
  noteType: VaultNoteType;
}): string {
  const { sessionState, noteType } = args;
  const workflow = sessionState.workflow ?? "session";
  const topic =
    normalizeTitleTopic(sessionState.prompt_excerpt) ??
    relatedTitleCandidate(noteType, sessionState);
  const date = isoDate(sessionState.started_at ?? sessionState.updated_at);
  return topic
    ? `${date} ${topic}`
    : `${date} Agmo ${workflow} checkpoint`;
}

async function resolveUniqueTitle(args: {
  cwd: string;
  project: string;
  noteType: VaultNoteType;
  proposedTitle: string;
  sessionState: SessionState;
}): Promise<string> {
  const { cwd, project, noteType, proposedTitle, sessionState } = args;
  const currentRef = sessionState.workflow
    ? sessionState.autosave_notes?.[sessionState.workflow]
    : null;
  if (currentRef?.title) {
    return currentRef.title;
  }

  const vault = await resolveVaultRoot(cwd);
  if (!vault.vault_root || vault.source === "none") {
    return proposedTitle;
  }

  const spec = CHECKPOINT_VAULT_TYPE_PATHS[noteType];
  const layout = resolveVaultProjectLayout(vault.vault_root, project);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? proposedTitle : `${proposedTitle} (${attempt + 1})`;
    const filename = `${spec.prefix} ${candidate}.md`;
    const relativePath =
      layout.storage_mode === "project-root"
        ? `${spec.subdir}/${filename}`.replace(/\\/g, "/")
        : `${project}/${spec.subdir}/${filename}`.replace(/\\/g, "/");
    if (currentRef?.relative_path === relativePath) {
      return candidate;
    }
    const targetPath = resolve(vault.vault_root, relativePath);
    const existing = await readTextFileIfExists(targetPath);
    if (existing === null) {
      return candidate;
    }
  }

  return `${proposedTitle} ${shortSessionId(sessionState.session_id)}`;
}

function sanitizeRenderedTitle(value: string): string | null {
  const normalized = value
    .replace(/\s+/g, " ")
    .replace(/[\/\\:*?"<>|]/g, "")
    .trim();
  return normalized || null;
}

function buildTitle(args: {
  sessionState: SessionState;
  noteType: VaultNoteType;
  project: string;
  autosavePolicy: Awaited<ReturnType<typeof resolveVaultAutosavePolicy>>["policy"];
}): string {
  const { sessionState, noteType, project, autosavePolicy } = args;
  const workflow = sessionState.workflow ?? "session";
  const existingTitle = sessionState.workflow
    ? sessionState.autosave_notes?.[sessionState.workflow]?.title
    : null;
  if (existingTitle) {
    return existingTitle;
  }

  const pattern = autosavePolicy.title_patterns[workflow];
  if (!pattern) {
    return buildDefaultTitle({ sessionState, noteType });
  }

  const rendered = sanitizeRenderedTitle(
    renderTemplateString(pattern, {
      date: isoDate(sessionState.started_at ?? sessionState.updated_at),
      topic:
        normalizeTitleTopic(sessionState.prompt_excerpt) ??
        relatedTitleCandidate(noteType, sessionState) ??
        `Agmo ${workflow}`,
      workflow,
      session_suffix: shortSessionId(sessionState.session_id),
      project,
      note_type: noteType
    })
  );

  return rendered ?? buildDefaultTitle({ sessionState, noteType });
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function yamlList(values: string[]): string[] {
  return values.map((value) => `  - ${yamlScalar(value)}`);
}

function dedupeNoteRefs(values: Array<SessionWorkflowNoteRef | null | undefined>): SessionWorkflowNoteRef[] {
  const seen = new Set<string>();
  const result: SessionWorkflowNoteRef[] = [];
  for (const value of values) {
    if (!value || seen.has(value.relative_path)) {
      continue;
    }
    seen.add(value.relative_path);
    result.push(value);
  }
  return result;
}

function resolveNoteRelations(
  noteType: VaultNoteType,
  sessionState: SessionState
): NoteRelations {
  const notes = sessionState.autosave_notes ?? {};
  const design = notes.brainstorming ?? null;
  const plan = notes.plan ?? null;

  if (noteType === "plan") {
    return {
      parent: design,
      related: dedupeNoteRefs([design])
    };
  }

  if (noteType === "impl") {
    return {
      parent: plan ?? design,
      related: dedupeNoteRefs([plan, design])
    };
  }

  return {
    parent: null,
    related: []
  };
}

function inferSchema(noteType: VaultNoteType): string {
  return `agmo-autosave-${noteType}-v2`;
}

function buildTitleAliases(title: string): string[] {
  const aliases = [title];
  const withoutDate = stripDerivedDecorators(title);
  if (withoutDate && withoutDate !== title) {
    aliases.push(withoutDate);
  }

  return Array.from(new Set(aliases));
}

function inferStatus(args: {
  noteType: VaultNoteType;
  trigger: SessionCheckpointTrigger;
  sessionState: SessionState;
}): string {
  const { noteType, trigger, sessionState } = args;
  if (noteType === "impl") {
    return trigger === "stop" || sessionState.last_event === "Stop" ? "done" : "in-progress";
  }
  if (noteType === "plan" || noteType === "design" || noteType === "research") {
    return trigger === "stop" ? "done" : "draft";
  }
  return "active";
}

async function collectChangedFiles(
  runtimeRoot: string,
  noteType: VaultNoteType,
  autosavePolicy: Awaited<ReturnType<typeof resolveVaultAutosavePolicy>>["policy"]
): Promise<string[]> {
  if (noteType !== "impl") {
    return [];
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--short", "--untracked-files=all"],
      { cwd: runtimeRoot }
    );
    return stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => line.replace(/^[ MARCUD?!]{1,2}\s+/, "").trim())
      .filter(Boolean)
      .map((line) => line.replace(/\\/g, "/"))
      .filter((line) => !shouldIgnoreChangedFile(line, autosavePolicy))
      .slice(0, 20);
  } catch {
    return [];
  }
}

function shouldIgnoreChangedFile(
  path: string,
  autosavePolicy: Awaited<ReturnType<typeof resolveVaultAutosavePolicy>>["policy"]
): boolean {
  const normalized = path.replace(/^\.\/+/, "");
  if (!normalized) {
    return true;
  }

  if (new Set(autosavePolicy.changed_file_ignore_basenames).has(normalized)) {
    return true;
  }

  if (
    autosavePolicy.changed_file_ignore_prefixes.some(
      (prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)
    )
  ) {
    return true;
  }

  const segments = normalized.split("/").filter(Boolean);
  const ignoredSegments = new Set(autosavePolicy.changed_file_ignore_segments);
  return segments.some((segment) => ignoredSegments.has(segment));
}

function summarizeVerificationEntry(entry: VerificationRecord): VerificationSummary {
  return {
    label: entry.tool_name || "tool",
    outcome: `${entry.tool_status}${entry.tool_summary ? ` — ${entry.tool_summary}` : ""}`,
    recordedAt: entry.recorded_at
  };
}

function collectVerificationSummary(
  sessionState: SessionState,
  autosavePolicy: Awaited<ReturnType<typeof resolveVaultAutosavePolicy>>["policy"]
): VerificationSummary[] {
  if (sessionState.verification_history?.length) {
    return sessionState.verification_history
      .slice(-Math.max(1, autosavePolicy.verification_history_limit))
      .reverse()
      .map(summarizeVerificationEntry);
  }

  if (!sessionState.last_tool_name && !sessionState.last_tool_summary) {
    return [];
  }

  return [
    {
      label: sessionState.last_tool_name ?? "tool",
      outcome: `${sessionState.last_tool_status ?? "unknown"}${sessionState.last_tool_summary ? ` — ${sessionState.last_tool_summary}` : ""}`,
      recordedAt: sessionState.updated_at
    }
  ];
}

function buildVerificationFrontmatter(args: {
  verification: VerificationSummary[];
}): string[] {
  const { verification } = args;
  if (verification.length === 0) {
    return [];
  }

  return [
    `verification_count: ${verification.length}`,
    `latest_verification_at: ${yamlScalar(
      verification.find((entry) => entry.recordedAt)?.recordedAt ?? ""
    )}`,
    "verification_tools:",
    ...yamlList(Array.from(new Set(verification.map((entry) => entry.label))))
  ];
}

function renderBulletList(
  values: string[],
  emptyFallback: string
): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : `- ${emptyFallback}`;
}

function renderChangedFilesTable(changedFiles: string[]): string {
  if (changedFiles.length === 0) {
    return ["| 파일 | 변경 내용 |", "|------|----------|", "| `{none}` | {변경 파일 없음} |"].join("\n");
  }

  return [
    "| 파일 | 변경 내용 |",
    "|------|----------|",
    ...changedFiles.map((entry) => `| \`${entry}\` | auto checkpoint detected change |`)
  ].join("\n");
}

function renderVerificationTable(verification: VerificationSummary[]): string {
  if (verification.length === 0) {
    return ["| 검증 | 결과 |", "|------|------|", "| `{none}` | {검증 기록 없음} |"].join("\n");
  }

  return [
    "| 검증 | 결과 |",
    "|------|------|",
    ...verification.map(
      (entry) =>
        `| ${entry.recordedAt ? `\`${entry.recordedAt}\` ${entry.label}` : entry.label} | ${entry.outcome} |`
    )
  ].join("\n");
}

function buildTypeSpecificFrontmatter(args: {
  noteType: VaultNoteType;
  trigger: SessionCheckpointTrigger;
  parent: SessionWorkflowNoteRef | null;
  related: SessionWorkflowNoteRef[];
  changedFiles: string[];
  verification: VerificationSummary[];
}): string[] {
  const { noteType, trigger, parent, related, changedFiles, verification } = args;
  const designRef =
    parent?.type === "design"
      ? parent.wikilink
      : related.find((entry) => entry.type === "design")?.wikilink;
  const planRef =
    parent?.type === "plan"
      ? parent.wikilink
      : related.find((entry) => entry.type === "plan")?.wikilink;

  switch (noteType) {
    case "design":
      return [
        `design_stage: ${yamlScalar(trigger === "stop" ? "finalized" : "exploring")}`,
        `plan_handoff_ready: ${trigger === "stop" ? "true" : "false"}`
      ];
    case "plan":
      return [
        `planning_stage: ${yamlScalar(trigger === "stop" ? "ready-for-execution" : "drafting")}`,
        ...(designRef ? [`design_ref: ${yamlScalar(designRef)}`] : [])
      ];
    case "impl":
      return [
        `implementation_stage: ${yamlScalar(trigger === "stop" ? "completed" : "active")}`,
        `changed_file_count: ${changedFiles.length}`,
        ...(planRef ? [`plan_ref: ${yamlScalar(planRef)}`] : [])
      ];
    case "research":
      return [`research_stage: ${yamlScalar(trigger === "stop" ? "captured" : "collecting")}`];
    case "memo":
      return [`memo_kind: ${yamlScalar("checkpoint")}`];
    case "meeting":
      return [`meeting_kind: ${yamlScalar("checkpoint")}`];
    default:
      return [];
  }
}

function buildFrontmatter(args: {
  title: string;
  noteType: VaultNoteType;
  project: string;
  projectWikiLink: string;
  trigger: SessionCheckpointTrigger;
  sessionState: SessionState;
  parent: SessionWorkflowNoteRef | null;
  related: SessionWorkflowNoteRef[];
  changedFiles: string[];
  verification: VerificationSummary[];
}): string[] {
  const {
    title,
    noteType,
    project,
    projectWikiLink,
    trigger,
    sessionState,
    parent,
    related,
    changedFiles,
    verification
  } = args;
  const createdAt = sessionState.started_at ?? sessionState.updated_at;
  const updatedAt = sessionState.completed_at ?? sessionState.updated_at;
  const workflow = sessionState.workflow ?? "unknown";
  const tags = Array.from(
    new Set([
      "agmo",
      "checkpoint",
      noteType,
      workflow,
      project,
      `type/${noteType}`,
      `workflow/${workflow}`,
      `project/${project}`
    ])
  );
  const frontmatter = [
    "---",
    `type: ${yamlScalar(noteType)}`,
    `schema: ${yamlScalar(inferSchema(noteType))}`,
    `project: ${yamlScalar(project)}`,
    `project_note: ${yamlScalar(projectWikiLink)}`,
    `session_id: ${yamlScalar(sessionState.session_id)}`,
    `workflow: ${yamlScalar(sessionState.workflow ?? "unknown")}`,
    `trigger: ${yamlScalar(trigger)}`,
    `status: ${yamlScalar(
      inferStatus({
        noteType,
        trigger,
        sessionState
      })
    )}`,
    `created: ${yamlScalar(isoDate(createdAt))}`,
    `updated: ${yamlScalar(isoDate(updatedAt))}`
  ];
  frontmatter.push("aliases:");
  frontmatter.push(...yamlList(buildTitleAliases(title)));

  if (parent) {
    frontmatter.push(`parent: ${yamlScalar(parent.wikilink)}`);
  }

  if (related.length > 0) {
    frontmatter.push("related:");
    frontmatter.push(...yamlList(related.map((entry) => entry.wikilink)));
  }

  frontmatter.push(
    ...buildTypeSpecificFrontmatter({
      noteType,
      trigger,
      parent,
      related,
      changedFiles,
      verification
    }),
    ...buildVerificationFrontmatter({ verification })
  );
  frontmatter.push("tags:");
  frontmatter.push(...yamlList(tags));
  frontmatter.push("---", "");
  return frontmatter;
}

function buildDetailSectionLines(args: {
  projectWikiLink: string;
  noteType: VaultNoteType;
  trigger: SessionCheckpointTrigger;
  sessionState: SessionState;
  changedFiles: string[];
  verification: VerificationSummary[];
}): string[] {
  const { sessionState, trigger, noteType, changedFiles, verification } = args;
  return (
    noteType === "design"
      ? buildDesignCheckpointSummary(sessionState, trigger)
      : noteType === "plan"
        ? [
            "## Plan Snapshot",
            "",
            `- Current Goal: ${sessionState.prompt_excerpt ?? "n/a"}`,
            `- Planning Context: ${sessionState.workflow_reason ?? "n/a"}`,
            "",
            "## Next Verification Signal",
            "",
            `- Last Event: ${sessionState.last_event}`,
            "",
            "## Notes",
            "",
            `- Auto-saved by Agmo native ${trigger} checkpoint.`
          ]
        : noteType === "research"
          ? buildResearchCheckpointSummary(sessionState, trigger)
          : noteType === "memo"
            ? [
                "## Memo Snapshot",
                "",
                sessionState.prompt_excerpt ?? "{no prompt excerpt captured}",
                "",
                "## Notes",
                "",
                `- Auto-saved by Agmo native ${trigger} checkpoint.`
              ]
            : [
                "## Changed Files",
                "",
                ...(changedFiles.length > 0
                  ? changedFiles.map((entry) => `- \`${entry}\``)
                  : ["- {no git changes detected or repository unavailable}"]),
                "",
                "## Verification Summary",
                "",
                ...(verification.length > 0
                  ? verification.map((entry) =>
                      `- ${entry.recordedAt ? `[${entry.recordedAt}] ` : ""}${entry.label}: ${entry.outcome}`
                    )
                  : ["- {no verification tool state captured}"]),
                "",
                "## Notes",
                "",
                `- Auto-saved by Agmo native ${trigger} checkpoint.`
              ]
  );
}

async function renderAutosaveTemplate(args: {
  noteType: VaultNoteType;
  policy: Awaited<ReturnType<typeof resolveVaultAutosavePolicy>>["policy"];
  templateValues: Record<string, string>;
  fallback: string;
}): Promise<string> {
  const configured = args.policy.template_files[args.noteType];
  const candidatePaths = configured
    ? [resolve(configured)]
    : agmoCliTemplateCandidatePaths("vault-autosave", `${args.noteType}.md`);

  for (const templatePath of candidatePaths) {
    const templateContent = await readTextFileIfExists(templatePath);
    if (templateContent === null) {
      continue;
    }

    const rendered = renderTemplateString(templateContent, args.templateValues);
    return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
  }

  return args.fallback;
}

function buildTemplateValues(args: {
  projectWikiLink: string;
  runtimeRoot: string;
  noteType: VaultNoteType;
  trigger: SessionCheckpointTrigger;
  appendSectionTitle?: string;
  sessionState: SessionState;
  parent: SessionWorkflowNoteRef | null;
  related: SessionWorkflowNoteRef[];
  changedFiles: string[];
  verification: VerificationSummary[];
  detailSection: string;
  frontmatter: string;
  title: string;
}): Record<string, string> {
  const {
    projectWikiLink,
    runtimeRoot,
    noteType,
    trigger,
    appendSectionTitle,
    sessionState,
    parent,
    related,
    changedFiles,
    verification,
    detailSection,
    frontmatter,
    title
  } = args;
  const relatedBullets = related.map((entry) => entry.wikilink);
  const verificationBullets = verification.map((entry) =>
    `${entry.recordedAt ? `[${entry.recordedAt}] ` : ""}${entry.label}: ${entry.outcome}`
  );
  const focus = resolveCheckpointFocus(noteType, sessionState);
  const capturedRequestBlockquote = renderQuotedLines(
    sessionState.prompt_excerpt,
    "{worker bootstrap prompt omitted}"
  ).join("\n");
  const recommendedNextStep =
    trigger === "stop"
      ? "Hand this design note to the planning lane and preserve the linked follow-up note."
      : "Continue the design lane until the tradeoffs are clear enough to hand off to plan.";
  const recommendedFollowUp =
    trigger === "stop"
      ? "Carry these findings into the downstream plan or implementation note and keep the references linked."
      : "Continue retrieval and synthesis until the evidence is strong enough to support a concrete recommendation.";

  return {
    frontmatter,
    title,
    project: basename(runtimeRoot),
    project_index: projectWikiLink,
    project_note_line: `> 프로젝트: ${projectWikiLink}`,
    parent_line: parent ? `> Parent: ${parent.wikilink}` : "",
    parent_link: parent?.wikilink ?? "",
    workflow: sessionState.workflow ?? "unknown",
    workflow_reason: sessionState.workflow_reason ?? "n/a",
    trigger,
    runtime_root: runtimeRoot,
    session_id: sessionState.session_id,
    last_event: sessionState.last_event,
    updated_at: sessionState.updated_at,
    started_at: sessionState.started_at ?? "n/a",
    completed_at: sessionState.completed_at ?? "n/a",
    prompt_excerpt: capturedRequestBlockquote,
    captured_request_blockquote: capturedRequestBlockquote,
    current_focus: focus,
    current_goal: focus,
    planning_context: sessionState.workflow_reason ?? "n/a",
    decision_context: sessionState.workflow_reason ?? "n/a",
    retrieval_context: sessionState.workflow_reason ?? "n/a",
    latest_signal: formatLatestSignal(sessionState),
    focus_statement:
      noteType === "design"
        ? `${focus} is the active design topic captured in this checkpoint.`
        : `${focus} is the current research topic preserved in this checkpoint.`,
    recommended_next_step: recommendedNextStep,
    recommended_follow_up: recommendedFollowUp,
    next_signal: sessionState.last_event,
    implementation_summary: `Agmo auto checkpoint captured during ${trigger}.`,
    key_implementation_details:
      sessionState.last_tool_summary ??
      sessionState.workflow_reason ??
      "Auto checkpoint captured current implementation state.",
    design_decisions:
      parent?.wikilink ??
      related.find((entry) => entry.type === "design")?.wikilink ??
      "Auto checkpoint preserved linked design/plan context.",
    changed_files_bullets: renderBulletList(
      changedFiles.map((entry) => `\`${entry}\``),
      "{변경 파일 없음}"
    ),
    changed_files_table: renderChangedFilesTable(changedFiles),
    verification_bullets: renderBulletList(
      verificationBullets,
      "{검증 기록 없음}"
    ),
    verification_table: renderVerificationTable(verification),
    last_tool_name: sessionState.last_tool_name ?? "n/a",
    last_tool_status: sessionState.last_tool_status ?? "n/a",
    last_tool_summary: sessionState.last_tool_summary ?? "n/a",
    related_links_bullets: renderBulletList(relatedBullets, "{related note or link}"),
    references_bullets: renderBulletList(
      [projectWikiLink, ...relatedBullets],
      "{links, files, sources}"
    ),
    related_section:
      related.length > 0
        ? ["## Related Links", "", ...related.map((entry) => `- ${entry.wikilink}`), ""].join(
            "\n"
          )
        : "",
    summary_lines: [
      `- Runtime Root: ${runtimeRoot}`,
      `- Session ID: ${sessionState.session_id}`,
      `- Workflow: ${sessionState.workflow ?? "unknown"}`,
      `- Workflow Reason: ${sessionState.workflow_reason ?? "n/a"}`,
      `- Last Event: ${sessionState.last_event}`,
      `- Updated At: ${sessionState.updated_at}`,
      `- Started At: ${sessionState.started_at ?? "n/a"}`,
      `- Completed At: ${sessionState.completed_at ?? "n/a"}`
    ].join("\n"),
    session_lines: [
      `- Runtime Root: ${runtimeRoot}`,
      `- Session ID: ${sessionState.session_id}`,
      `- Workflow: ${sessionState.workflow ?? "unknown"}`,
      `- Workflow Reason: ${sessionState.workflow_reason ?? "n/a"}`,
      `- Started At: ${sessionState.started_at ?? "n/a"}`
    ].join("\n"),
    append_section_title: appendSectionTitle ?? "Auto Checkpoints",
    append_entry: detailSection,
    detail_section: detailSection,
    note_type: noteType
  };
}

function buildContent(args: {
  projectWikiLink: string;
  runtimeRoot: string;
  noteType: VaultNoteType;
  trigger: SessionCheckpointTrigger;
  sessionState: SessionState;
  parent: SessionWorkflowNoteRef | null;
  related: SessionWorkflowNoteRef[];
  changedFiles: string[];
  verification: VerificationSummary[];
  autosavePolicy: Awaited<ReturnType<typeof resolveVaultAutosavePolicy>>["policy"];
}): Promise<string> {
  const {
    projectWikiLink,
    runtimeRoot,
    sessionState,
    trigger,
    noteType,
    parent,
    related,
    changedFiles,
    verification,
    autosavePolicy
  } = args;
  const detailSections = buildDetailSectionLines({
    projectWikiLink,
    noteType,
    trigger,
    sessionState,
    changedFiles,
    verification
  });
  const title = buildTitle({ sessionState, noteType, project: basename(runtimeRoot), autosavePolicy });

  const lines = [
    ...buildFrontmatter({
      title,
      noteType,
      project: basename(runtimeRoot),
      projectWikiLink,
      trigger,
      sessionState,
      parent,
      related,
      changedFiles,
      verification
    }),
    "",
    `# ${title}`,
    "",
    `> Project Index: ${projectWikiLink}`,
    ...(parent ? [`> Parent: ${parent.wikilink}`] : []),
    "",
    "## Summary",
    "",
    `- Runtime Root: ${runtimeRoot}`,
    `- Session ID: ${sessionState.session_id}`,
    `- Workflow: ${sessionState.workflow ?? "unknown"}`,
    `- Workflow Reason: ${sessionState.workflow_reason ?? "n/a"}`,
    `- Last Event: ${sessionState.last_event}`,
    `- Updated At: ${sessionState.updated_at}`,
    `- Started At: ${sessionState.started_at ?? "n/a"}`,
    `- Completed At: ${sessionState.completed_at ?? "n/a"}`,
    "",
    "## Prompt Excerpt",
    "",
    sessionState.prompt_excerpt ?? "{no prompt excerpt captured}",
    "",
    ...(related.length > 0
      ? [
          "## Related Links",
          "",
          ...related.map((entry) => `- ${entry.wikilink}`),
          ""
        ]
      : []),
    ...detailSections
  ].filter((line): line is string => line !== null);

  const frontmatter = buildFrontmatter({
    title,
    noteType,
    project: basename(runtimeRoot),
    projectWikiLink,
    trigger,
    sessionState,
    parent,
    related,
    changedFiles,
    verification
  }).join("\n");
  const fallback = `${lines.join("\n")}\n`;
  return renderAutosaveTemplate({
    noteType,
    policy: autosavePolicy,
    templateValues: buildTemplateValues({
      projectWikiLink,
      runtimeRoot,
      noteType,
      trigger,
      sessionState,
      parent,
      related,
      changedFiles,
      verification,
      detailSection: detailSections.join("\n"),
      frontmatter,
      title
    }),
    fallback
  });
}

function buildCheckpointSectionEntry(args: {
  noteType: VaultNoteType;
  trigger: SessionCheckpointTrigger;
  sessionState: SessionState;
  changedFiles: string[];
  verification: VerificationSummary[];
}): string {
  const { trigger, sessionState, noteType, changedFiles, verification } = args;
  const focusLabel =
    noteType === "design"
      ? "Design Focus"
      : noteType === "plan"
        ? "Plan Focus"
        : noteType === "research"
          ? "Research Focus"
          : noteType === "memo"
            ? "Memo Focus"
            : "Implementation Focus";
  return [
    `### ${sessionState.completed_at ?? sessionState.updated_at} — ${trigger}`,
    "",
    `- ${focusLabel}: ${sessionState.prompt_excerpt ?? "n/a"}`,
    `- Last Event: ${sessionState.last_event}`,
    `- Workflow Reason: ${sessionState.workflow_reason ?? "n/a"}`,
    `- Last Tool: ${sessionState.last_tool_name ?? "n/a"}`,
    `- Tool Status: ${sessionState.last_tool_status ?? "n/a"}`,
    `- Tool Summary: ${sessionState.last_tool_summary ?? "n/a"}`,
    ...(noteType === "impl"
      ? [
          `- Changed Files: ${
            changedFiles.length > 0 ? changedFiles.map((entry) => `\`${entry}\``).join(", ") : "n/a"
          }`,
          `- Verification: ${
            verification.length > 0
              ? verification
                  .map((entry) =>
                    `${entry.recordedAt ? `[${entry.recordedAt}] ` : ""}${entry.label}=${entry.outcome}`
                  )
                  .join("; ")
              : "n/a"
          }`
        ]
      : []),
    "",
    "#### Prompt Excerpt",
    "",
    sessionState.prompt_excerpt ?? "{no prompt excerpt captured}"
  ].join("\n");
}

function buildAppendModeContent(args: {
  projectWikiLink: string;
  runtimeRoot: string;
  noteType: VaultNoteType;
  trigger: SessionCheckpointTrigger;
  appendSectionTitle: string;
  sessionState: SessionState;
  parent: SessionWorkflowNoteRef | null;
  related: SessionWorkflowNoteRef[];
  changedFiles: string[];
  verification: VerificationSummary[];
  autosavePolicy: Awaited<ReturnType<typeof resolveVaultAutosavePolicy>>["policy"];
}): Promise<string> {
  const {
    projectWikiLink,
    runtimeRoot,
    sessionState,
    trigger,
    noteType,
    appendSectionTitle,
    parent,
    related,
    changedFiles,
    verification,
    autosavePolicy
  } = args;
  const title = buildTitle({ sessionState, noteType, project: basename(runtimeRoot), autosavePolicy });
  const lines = [
    ...buildFrontmatter({
      title,
      noteType,
      project: basename(runtimeRoot),
      projectWikiLink,
      trigger,
      sessionState,
      parent,
      related,
      changedFiles,
      verification
    }),
    "",
    `# ${title}`,
    "",
    `> Project Index: ${projectWikiLink}`,
    ...(parent ? [`> Parent: ${parent.wikilink}`] : []),
    "",
    "## Session",
    "",
    `- Runtime Root: ${runtimeRoot}`,
    `- Session ID: ${sessionState.session_id}`,
    `- Workflow: ${sessionState.workflow ?? "unknown"}`,
    `- Workflow Reason: ${sessionState.workflow_reason ?? "n/a"}`,
    `- Started At: ${sessionState.started_at ?? "n/a"}`,
    "",
    ...(related.length > 0
      ? [
          "## Related Links",
          "",
          ...related.map((entry) => `- ${entry.wikilink}`),
          ""
        ]
      : []),
    `## ${appendSectionTitle}`,
    "",
    buildCheckpointSectionEntry({
      noteType,
      trigger,
      sessionState,
      changedFiles,
      verification
    })
  ].filter((line): line is string => line !== null);

  const appendEntry = buildCheckpointSectionEntry({
    noteType,
    trigger,
    sessionState,
    changedFiles,
    verification
  });
  const frontmatter = buildFrontmatter({
    title,
    noteType,
    project: basename(runtimeRoot),
    projectWikiLink,
    trigger,
    sessionState,
    parent,
    related,
    changedFiles,
    verification
  }).join("\n");
  const fallback = `${lines.join("\n")}\n`;
  return renderAutosaveTemplate({
    noteType,
    policy: autosavePolicy,
    templateValues: buildTemplateValues({
      projectWikiLink,
      runtimeRoot,
      noteType,
      trigger,
      appendSectionTitle,
      sessionState,
      parent,
      related,
      changedFiles,
      verification,
      detailSection: `## ${appendSectionTitle}\n\n${appendEntry}`,
      frontmatter,
      title
    }),
    fallback
  });
}

function buildAutosaveSignature(args: {
  noteType: VaultNoteType;
  trigger: SessionCheckpointTrigger;
  sessionState: SessionState;
}): string {
  const { noteType, trigger, sessionState } = args;
  const latestVerification =
    sessionState.verification_history?.[sessionState.verification_history.length - 1] ?? null;
  return JSON.stringify({
    noteType,
    trigger,
    workflow: sessionState.workflow ?? null,
    lastEvent: sessionState.last_event,
    promptExcerpt: sessionState.prompt_excerpt ?? null,
    toolName: sessionState.last_tool_name ?? null,
    toolStatus: sessionState.last_tool_status ?? null,
    toolSummary: sessionState.last_tool_summary ?? null,
    verificationCount: sessionState.verification_history?.length ?? 0,
    latestVerificationAt: latestVerification?.recorded_at ?? null
  });
}

function shouldSkipAutosave(args: {
  autosavePolicy: Awaited<ReturnType<typeof resolveVaultAutosavePolicy>>["policy"];
  signature: string;
  trigger: SessionCheckpointTrigger;
  sessionState: SessionState;
}): boolean {
  const { autosavePolicy, signature, sessionState, trigger } = args;
  if (
    autosavePolicy.dedupe_same_signature &&
    sessionState.last_autosave_signature === signature
  ) {
    return true;
  }

  if (trigger === "stop") {
    return false;
  }

  if (
    sessionState.last_autosave_workflow &&
    sessionState.workflow &&
    sessionState.last_autosave_workflow !== sessionState.workflow
  ) {
    return false;
  }

  if (!sessionState.last_autosave_at || autosavePolicy.min_interval_ms <= 0) {
    return false;
  }

  const previousAt = Date.parse(sessionState.last_autosave_at);
  const currentAt = Date.parse(sessionState.completed_at ?? sessionState.updated_at);
  if (!Number.isFinite(previousAt) || !Number.isFinite(currentAt)) {
    return false;
  }

  return currentAt - previousAt < autosavePolicy.min_interval_ms;
}

export async function saveSessionCheckpointNote(args: {
  cwd: string;
  trigger: SessionCheckpointTrigger;
  sessionState: SessionState;
}): Promise<{
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
} | null> {
  const autosave = await resolveVaultAutosavePolicy(args.cwd);
  if (!autosave.policy.enabled) {
    return null;
  }

  if (
    (args.trigger === "stop" && !autosave.policy.on_stop) ||
    (args.trigger === "post_tool_use_success" &&
      !autosave.policy.on_post_tool_use_success) ||
    (args.trigger === "workflow_change" && !autosave.policy.on_workflow_change)
  ) {
    return null;
  }

  if (!args.sessionState.workflow) {
    return null;
  }

  if (autosave.policy.workflow_enabled[args.sessionState.workflow] === false) {
    return null;
  }

  const runtimeRoot = resolveRuntimeRoot(args.cwd);
  const project = basename(runtimeRoot);
  const vault = await resolveVaultRoot(args.cwd);
  const projectWikiLink =
    vault.vault_root && vault.source !== "none"
      ? resolveVaultProjectLayout(vault.vault_root, project).project_note_wikilink
      : `[[${project}/${project}]]`;
  const noteType = resolveCheckpointType(
    args.sessionState.workflow,
    autosave.policy.workflow_types
  );
  const resolvedTitle = await resolveUniqueTitle({
    cwd: args.cwd,
    project,
    noteType,
    proposedTitle: buildTitle({
      sessionState: args.sessionState,
      noteType,
      project,
      autosavePolicy: autosave.policy
    }),
    sessionState: args.sessionState
  });
  const renderSessionState: SessionState = {
    ...args.sessionState,
    autosave_notes: {
      ...(args.sessionState.autosave_notes ?? {}),
      [args.sessionState.workflow]: {
        workflow: args.sessionState.workflow,
        type: noteType,
        title: resolvedTitle,
        relative_path:
          args.sessionState.autosave_notes?.[args.sessionState.workflow]?.relative_path ?? "",
        wikilink: args.sessionState.autosave_notes?.[args.sessionState.workflow]?.wikilink ?? "",
        saved_at:
          args.sessionState.autosave_notes?.[args.sessionState.workflow]?.saved_at ??
          (args.sessionState.completed_at ?? args.sessionState.updated_at)
      }
    }
  };
  const relations = resolveNoteRelations(noteType, args.sessionState);
  const changedFiles = await collectChangedFiles(runtimeRoot, noteType, autosave.policy);
  const verification = collectVerificationSummary(renderSessionState, autosave.policy);
  const signature = buildAutosaveSignature({
    noteType,
    trigger: args.trigger,
    sessionState: renderSessionState
  });
  if (
    shouldSkipAutosave({
      autosavePolicy: autosave.policy,
      signature,
      trigger: args.trigger,
      sessionState: args.sessionState
    })
  ) {
    return null;
  }
  const updateMode = autosave.policy.update_mode;
  const appendSectionTitle = autosave.policy.append_section_title;
  const result = await upsertVaultTextNote(
    {
      type: noteType,
      project,
      title: resolvedTitle,
      content:
        updateMode === "append-section"
          ? await buildAppendModeContent({
              projectWikiLink,
              runtimeRoot,
              noteType,
              trigger: args.trigger,
              appendSectionTitle,
              sessionState: renderSessionState,
              parent: relations.parent,
              related: relations.related,
              changedFiles,
              verification,
              autosavePolicy: autosave.policy
            })
          : await buildContent({
              projectWikiLink,
              runtimeRoot,
              noteType,
              trigger: args.trigger,
              sessionState: renderSessionState,
              parent: relations.parent,
              related: relations.related,
              changedFiles,
              verification,
              autosavePolicy: autosave.policy
            }),
      index: true,
      update_mode: updateMode,
      append_section_title: appendSectionTitle,
      append_content:
        updateMode === "append-section"
          ? buildCheckpointSectionEntry({
              noteType,
              trigger: args.trigger,
              sessionState: renderSessionState,
              changedFiles,
              verification
            })
          : undefined,
      append_max_entries:
        updateMode === "append-section"
          ? autosave.policy.append_max_entries
          : undefined
    },
    runtimeRoot
  );

  await recordSessionAutosave({
    cwd: args.cwd,
    payload: { session_id: args.sessionState.session_id },
    autosaveAt: args.sessionState.completed_at ?? args.sessionState.updated_at,
    autosaveTrigger: args.trigger,
    autosaveSignature: signature,
    autosaveWorkflow: args.sessionState.workflow,
    noteRef: {
      workflow: args.sessionState.workflow,
      type: noteType,
      title: resolvedTitle,
      relative_path: result.relative_path,
      wikilink: result.wikilink,
      saved_at: args.sessionState.completed_at ?? args.sessionState.updated_at
    }
  });

  await syncAutoLinks({
    cwd: args.cwd,
    noteType,
    current: {
      workflow: args.sessionState.workflow,
      type: noteType,
      title: resolvedTitle,
      relative_path: result.relative_path,
      wikilink: result.wikilink,
      saved_at: args.sessionState.completed_at ?? args.sessionState.updated_at
    },
    relations
  });

  return result;
}

async function syncAutoLinks(args: {
  cwd: string;
  noteType: VaultNoteType;
  current: SessionWorkflowNoteRef;
  relations: NoteRelations;
}): Promise<void> {
  try {
    if (args.noteType === "plan" && args.relations.parent) {
      await appendVaultSectionLine(
        {
          relative_path: args.relations.parent.relative_path,
          section: "Plans",
          line: `- Plan: ${args.current.wikilink}`
        },
        args.cwd
      );
    }

    if (args.noteType === "impl") {
      const plan = args.relations.related.find((entry) => entry.type === "plan");
      if (plan) {
        await appendVaultSectionLine(
          {
            relative_path: plan.relative_path,
            section: "Implementations",
            line: `- Impl: ${args.current.wikilink}`
          },
          args.cwd
        );
      }
    }
  } catch {
    // Backlinks are best-effort; note persistence should not fail if backlinking fails.
  }
}
