import { join, relative } from "node:path";
import type {
  AgmoHookPayload,
  SessionState,
  SessionWorkflowNoteRef
} from "../hooks/runtime-state.js";
import { readOptionalSessionId, safeFileStem } from "../hooks/runtime-state.js";
import { writeJsonFile } from "../utils/fs.js";
import { resolveInstallPaths } from "../utils/paths.js";
import type { AgmoTaskIntent } from "./role-router.js";
import { slugifyTask } from "./state/index.js";
import { currentTmuxPaneId, isTmuxAvailable } from "./tmux-session.js";
import { startTeamRuntime } from "./runtime.js";

type TeamEscalationTrigger = "explicit-skill" | "natural-language";

export type AgmoTeamEscalationIntent = {
  trigger: TeamEscalationTrigger;
  workerCount: number;
  allocationIntent: AgmoTaskIntent;
  requestedTaskText: string | null;
  requestedTeamName: string | null;
  prompt: string;
};

type AgmoTeamHandoffRecord = {
  version: 1;
  created_at: string;
  session_id: string | null;
  workflow: string | null;
  workflow_reason: string | null;
  prompt_excerpt: string | null;
  requested_prompt: string;
  trigger: TeamEscalationTrigger;
  worker_count: number;
  allocation_intent: AgmoTaskIntent;
  requested_team_name: string | null;
  requested_task_text: string | null;
  team_name: string;
  task_summary: string;
  notes: {
    design: SessionWorkflowNoteRef | null;
    plan: SessionWorkflowNoteRef | null;
    implementation: SessionWorkflowNoteRef | null;
  };
};

export type AgmoTeamEscalationResult =
  | {
      status: "started";
      teamName: string;
      workerCount: number;
      allocationIntent: AgmoTaskIntent;
      taskSummary: string;
      handoffPath: string;
      handoffPathRelative: string;
      tmuxWorkerPaneCount: number;
      hudEnabled: boolean;
      leaderPaneId: string | null;
    }
  | {
      status: "deferred";
      reason: string;
      teamName: string;
      workerCount: number;
      allocationIntent: AgmoTaskIntent;
      taskSummary: string;
      handoffPath: string;
      handoffPathRelative: string;
    };

const EXPLICIT_TEAM_PATTERN = /^\$team\b/i;
const NATURAL_TEAM_PATTERNS: RegExp[] = [
  /(?:team|팀).*(?:으로|모드로)?.*(?:넘겨|전환|시작|이어가|띄워|돌려)/iu,
  /(?:병렬|parallel).*(?:구현|executor|worker)?.*(?:시작|진행|돌려|띄워|넘겨|전환)/iu,
  /(?:worker|executor).*(?:\d+).*(?:나눠|분할|병렬|시작|진행)/iu
];

function nowIso(): string {
  return new Date().toISOString();
}

function shortSessionSuffix(sessionId: string | null): string {
  return safeFileStem(sessionId ?? "session").slice(-8) || "session";
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseWorkerCount(raw: string): number | null {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    return null;
  }
  return parsed;
}

function parseWorkerCountFromPrompt(prompt: string): number | null {
  const direct = prompt.match(/(?:^|\s)(\d{1,2})(?:\s*(?:명|개|workers?))?(?=\s|$)/iu)?.[1];
  return direct ? parseWorkerCount(direct) : null;
}

function inferAllocationIntent(prompt: string): AgmoTaskIntent {
  const normalized = prompt.toLowerCase();

  if (
    /\b(verify|verification|test|review|qa)\b/i.test(normalized) ||
    /(검증|테스트|리뷰|확인)/u.test(prompt)
  ) {
    return "verification";
  }

  if (
    /\b(plan|planning|design|strategy)\b/i.test(normalized) ||
    /(계획|설계|전략|분해)/u.test(prompt)
  ) {
    return "planning";
  }

  if (
    /\b(research|docs?|knowledge)\b/i.test(normalized) ||
    /(문서|리서치|조사|지식)/u.test(prompt)
  ) {
    return "knowledge";
  }

  return "implementation";
}

function parseRequestedTeamName(prompt: string): string | null {
  const inline = prompt.match(/--name=(\S+)/i)?.[1];
  if (inline) {
    return stripOuterQuotes(inline);
  }

  const spaced = prompt.match(/--name\s+(".*?"|'.*?'|\S+)/i)?.[1];
  return spaced ? stripOuterQuotes(spaced) : null;
}

function stripParsedTeamOptions(prompt: string): string {
  return prompt
    .replace(EXPLICIT_TEAM_PATTERN, "")
    .replace(/--name=(\S+)/gi, "")
    .replace(/--name\s+(".*?"|'.*?'|\S+)/gi, "")
    .trim();
}

function normalizeRequestedTaskText(prompt: string, workerCount: number | null): string | null {
  let remaining = stripParsedTeamOptions(prompt);

  if (workerCount !== null) {
    remaining = remaining.replace(new RegExp(`^${workerCount}(?:\\s*(?:명|개|workers?))?\\b`, "iu"), "").trim();
  }

  const quoted = remaining.match(/^(".*"|\'.*\')$/)?.[1];
  const normalized = stripOuterQuotes(quoted ?? remaining).trim();
  return normalized.length > 0 ? normalized : null;
}

export function detectTeamEscalationIntent(
  prompt: string
): AgmoTeamEscalationIntent | null {
  const normalized = prompt.trim();
  if (!normalized) {
    return null;
  }

  if (EXPLICIT_TEAM_PATTERN.test(normalized)) {
    const workerCount = parseWorkerCountFromPrompt(normalized) ?? 3;
    return {
      trigger: "explicit-skill",
      workerCount,
      allocationIntent: inferAllocationIntent(normalized),
      requestedTaskText: normalizeRequestedTaskText(normalized, workerCount),
      requestedTeamName: parseRequestedTeamName(normalized),
      prompt: normalized
    };
  }

  if (NATURAL_TEAM_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      trigger: "natural-language",
      workerCount: parseWorkerCountFromPrompt(normalized) ?? 3,
      allocationIntent: inferAllocationIntent(normalized),
      requestedTaskText: null,
      requestedTeamName: null,
      prompt: normalized
    };
  }

  return null;
}

function buildContextualTaskSummary(args: {
  sessionState: SessionState | null;
  intent: AgmoTeamEscalationIntent;
  handoffPathRelative: string;
}): string {
  const sessionId = args.sessionState?.session_id ?? null;
  const promptExcerpt = args.sessionState?.prompt_excerpt?.trim() || null;
  const workflow = args.sessionState?.workflow?.trim() || null;
  const workflowReason = args.sessionState?.workflow_reason?.trim() || null;
  const notes = args.sessionState?.autosave_notes ?? {};
  const planNote = notes.plan?.wikilink ?? null;
  const designNote = notes.brainstorming?.wikilink ?? null;
  const implNote = notes.execute?.wikilink ?? null;
  const primaryObjective =
    args.intent.requestedTaskText ??
    promptExcerpt ??
    "Continue the active Agmo session task in parallel.";

  return [
    primaryObjective,
    "",
    "## Same-session Agmo handoff",
    `- Trigger: ${args.intent.trigger}`,
    `- Handoff artifact: ${args.handoffPathRelative}`,
    ...(sessionId ? [`- Source session: ${sessionId}`] : []),
    ...(workflow ? [`- Source workflow: ${workflow}`] : []),
    ...(workflowReason ? [`- Workflow reason: ${workflowReason}`] : []),
    ...(planNote ? [`- Latest plan note: ${planNote}`] : []),
    ...(designNote ? [`- Latest design note: ${designNote}`] : []),
    ...(implNote ? [`- Latest implementation note: ${implNote}`] : []),
    "",
    "Use the linked handoff/context artifacts before making implementation decisions."
  ].join("\n");
}

async function writeTeamHandoff(args: {
  cwd: string;
  payload: AgmoHookPayload;
  sessionState: SessionState | null;
  intent: AgmoTeamEscalationIntent;
  teamName: string;
  taskSummary: string;
}): Promise<{ path: string; relativePath: string }> {
  const { handoffsDir, projectRoot } = resolveInstallPaths("project", args.cwd);
  const fileName = `${safeFileStem(args.teamName)}.json`;
  const handoffPath = join(handoffsDir, fileName);

  const handoffRecord: AgmoTeamHandoffRecord = {
    version: 1,
    created_at: nowIso(),
    session_id: readOptionalSessionId(args.payload),
    workflow: args.sessionState?.workflow ?? null,
    workflow_reason: args.sessionState?.workflow_reason ?? null,
    prompt_excerpt: args.sessionState?.prompt_excerpt ?? null,
    requested_prompt: args.intent.prompt,
    trigger: args.intent.trigger,
    worker_count: args.intent.workerCount,
    allocation_intent: args.intent.allocationIntent,
    requested_team_name: args.intent.requestedTeamName,
    requested_task_text: args.intent.requestedTaskText,
    team_name: args.teamName,
    task_summary: args.taskSummary,
    notes: {
      design: args.sessionState?.autosave_notes?.brainstorming ?? null,
      plan: args.sessionState?.autosave_notes?.plan ?? null,
      implementation: args.sessionState?.autosave_notes?.execute ?? null
    }
  };

  await writeJsonFile(handoffPath, handoffRecord);
  return {
    path: handoffPath,
    relativePath: relative(projectRoot, handoffPath) || handoffPath
  };
}

function resolveTeamName(
  sessionState: SessionState | null,
  intent: AgmoTeamEscalationIntent
): string {
  if (intent.requestedTeamName) {
    return intent.requestedTeamName;
  }

  const topic =
    intent.requestedTaskText ??
    sessionState?.prompt_excerpt ??
    `${sessionState?.workflow ?? "team"}-handoff`;

  const slug = slugifyTask(topic);
  return `${slug}-${shortSessionSuffix(sessionState?.session_id ?? null)}`;
}

export async function escalateToSameSessionTeam(args: {
  cwd: string;
  payload: AgmoHookPayload;
  prompt: string;
  sessionState: SessionState | null;
}): Promise<AgmoTeamEscalationResult | null> {
  const intent = detectTeamEscalationIntent(args.prompt);
  if (!intent) {
    return null;
  }

  const sessionId = args.sessionState?.session_id ?? readOptionalSessionId(args.payload);
  const teamName = resolveTeamName(args.sessionState, intent);
  const handoffPreviewRelative = join(".agmo", "handoffs", `${safeFileStem(teamName)}.json`);
  const taskSummary = buildContextualTaskSummary({
    sessionState: args.sessionState,
    intent,
    handoffPathRelative: handoffPreviewRelative
  });
  const handoff = await writeTeamHandoff({
    cwd: args.cwd,
    payload: args.payload,
    sessionState: args.sessionState,
    intent,
    teamName,
    taskSummary
  });

  if (!isTmuxAvailable() || !currentTmuxPaneId()) {
    return {
      status: "deferred",
      reason: "same-session team escalation requires launching the leader inside tmux",
      teamName,
      workerCount: intent.workerCount,
      allocationIntent: intent.allocationIntent,
      taskSummary,
      handoffPath: handoff.path,
      handoffPathRelative: handoff.relativePath
    };
  }

  const started = await startTeamRuntime(
    {
      teamName,
      workerCount: intent.workerCount,
      task: taskSummary,
      mode: "interactive",
      sessionId,
      spawnTmuxPanes: true,
      tmuxSpawnIntent: "live-team-runtime",
      hud: true,
      allocationIntent: intent.allocationIntent
    },
    args.cwd
  );

  const config = started.config as {
    tmux: { worker_pane_ids: Record<string, string>; hud_pane_id?: string | null; leader_pane_id: string | null };
  };

  return {
    status: "started",
    teamName,
    workerCount: intent.workerCount,
    allocationIntent: intent.allocationIntent,
    taskSummary,
    handoffPath: handoff.path,
    handoffPathRelative: handoff.relativePath,
    tmuxWorkerPaneCount: Object.keys(config.tmux.worker_pane_ids ?? {}).length,
    hudEnabled: Boolean(config.tmux.hud_pane_id),
    leaderPaneId: config.tmux.leader_pane_id ?? null
  };
}
