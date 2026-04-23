import { saveSessionCheckpointNote } from "../vault/checkpoint.js";
import { persistSessionWisdomOutcome } from "../wisdom/store.js";
import {
  recordSessionActivity,
  readPersistedSessionState,
  type AgmoHookPayload
} from "./runtime-state.js";

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
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
    payload.stdout,
    payload.stderr,
    payload.output,
    payload.response
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const summary = summarizeText(candidate);
      if (summary) {
        return summary;
      }
    }
  }

  return undefined;
}

function detectFailure(payload: AgmoHookPayload): boolean {
  const exitCode = safeNumber(payload.exit_code ?? payload.exitCode ?? payload.status_code);
  if (exitCode !== null) {
    return exitCode !== 0;
  }

  const explicit =
    payload.success ??
    payload.ok ??
    payload.failed ??
    payload.error ??
    payload.is_error ??
    payload.isError;

  if (typeof explicit === "boolean") {
    if ("failed" in payload || "error" in payload || "is_error" in payload || "isError" in payload) {
      return explicit;
    }

    return explicit === false;
  }

  const stderr = safeString(payload.stderr);
  return /\berror\b|\bfailed\b/i.test(stderr);
}

export async function handlePostToolUse(args: {
  cwd: string;
  payload: AgmoHookPayload;
}): Promise<{ hookSpecificOutput: { hookEventName: "PostToolUse"; additionalContext: string } } | null> {
  const failed = detectFailure(args.payload);
  const toolName = detectToolName(args.payload);
  const toolSummary = detectToolSummary(args.payload);

  await recordSessionActivity({
    cwd: args.cwd,
    payload: args.payload,
    lastEvent: "PostToolUse",
    toolName,
    toolSummary,
    toolStatus: failed ? "failed" : "succeeded"
  });

  if (!failed) {
    const sessionState = await readPersistedSessionState(args);
    if (sessionState) {
      try {
        await saveSessionCheckpointNote({
          cwd: args.cwd,
          trigger: "post_tool_use_success",
          sessionState
        });
      } catch (error) {
        void error;
      }

      try {
        const persistedState = (await readPersistedSessionState(args)) ?? sessionState;
        await persistSessionWisdomOutcome({
          cwd: args.cwd,
          sessionState: persistedState,
          trigger: "post_tool_use_success"
        });
      } catch (error) {
        void error;
      }
    }
    return null;
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `Agmo native PostToolUse observed a failed tool call${toolName ? ` for ${toolName}` : ""}. Read the actual tool output, update the plan from that evidence, and prefer the smallest verified recovery step instead of restating the previous plan.`
    }
  };
}
