import { recordSessionActivity, type AgmoHookPayload } from "./runtime-state.js";

type PreToolContext = {
  toolName?: string;
  toolSummary?: string;
  riskReason?: string;
};

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function summarizeText(value: string, maxLength = 220): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.slice(0, maxLength);
}

function detectToolName(payload: AgmoHookPayload): string | undefined {
  return (
    safeString(payload.tool_name) ||
    safeString(payload.toolName) ||
    safeString(payload.tool) ||
    safeString(payload.matcher)
  ) || undefined;
}

function detectToolSummary(payload: AgmoHookPayload): string | undefined {
  const candidates: unknown[] = [
    payload.command,
    payload.input,
    payload.args,
    payload.tool_input,
    payload.toolInput
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const summary = summarizeText(candidate);
      if (summary) {
        return summary;
      }
    }

    if (candidate && typeof candidate === "object") {
      const nested = candidate as Record<string, unknown>;
      for (const key of ["command", "cmd", "input", "query", "description"]) {
        const summary = summarizeText(safeString(nested[key]));
        if (summary) {
          return summary;
        }
      }

      try {
        const summary = summarizeText(JSON.stringify(candidate));
        if (summary) {
          return summary;
        }
      } catch {
        // ignore
      }
    }
  }

  return undefined;
}

function detectRiskReason(summary: string | undefined): string | undefined {
  if (!summary) {
    return undefined;
  }

  const patterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\brm\s+-rf\b/i, reason: "destructive rm -rf command detected" },
    { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "hard git reset detected" },
    { pattern: /\bgit\s+clean\s+-[^\n]*f/i, reason: "force git clean detected" },
    { pattern: /\bmkfs\b|\bdd\s+if=/i, reason: "low-level disk write command detected" }
  ];

  return patterns.find((entry) => entry.pattern.test(summary))?.reason;
}

function buildContext(payload: AgmoHookPayload): PreToolContext {
  const toolName = detectToolName(payload);
  const toolSummary = detectToolSummary(payload);

  return {
    toolName,
    toolSummary,
    riskReason: detectRiskReason(toolSummary)
  };
}

export async function handlePreToolUse(args: {
  cwd: string;
  payload: AgmoHookPayload;
}): Promise<{ hookSpecificOutput: { hookEventName: "PreToolUse"; additionalContext: string } } | null> {
  const context = buildContext(args.payload);

  await recordSessionActivity({
    cwd: args.cwd,
    payload: args.payload,
    lastEvent: "PreToolUse",
    toolName: context.toolName,
    toolSummary: context.toolSummary,
    toolStatus: "running"
  });

  if (!context.riskReason) {
    return null;
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: `Agmo native PreToolUse flagged this tool call as high risk (${context.riskReason}). Preserve durable runtime state, prefer reversible edits/worktree-safe operations, and avoid destructive commands unless the user explicitly requested them.`
    }
  };
}
