import {
  removeSessionComposedAgentsFile,
  writeSessionComposedAgentsFile
} from "../agents/agents-md.js";
import { handlePostToolUse } from "../hooks/post-tool-use.js";
import { handlePreToolUse } from "../hooks/pre-tool-use.js";
import { buildSessionStartContext } from "../hooks/session-start.js";
import { handleStop } from "../hooks/stop.js";
import { handleUserPromptSubmit } from "../hooks/user-prompt-submit.js";
import { recordWorkerHookActivity } from "../team/runtime.js";
import { resolveRuntimeRoot } from "../utils/paths.js";

type HookPayload = {
  hook_event_name?: string;
  event_name?: string;
  eventName?: string;
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf-8").trim();
}

function resolveHookEvent(args: string[], payload: HookPayload | null): string {
  return (
    args[1] ??
    payload?.hook_event_name ??
    payload?.event_name ??
    payload?.eventName ??
    ""
  );
}

export async function runInternalCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === "agents") {
    const action = args[1];
    const sessionId = args[2];

    if (!sessionId || (action !== "compose-session" && action !== "remove-session")) {
      console.error(
        "Usage: agmo internal agents <compose-session|remove-session> <session-id>"
      );
      process.exitCode = 1;
      return;
    }

    if (action === "compose-session") {
      const result = await writeSessionComposedAgentsFile({
        cwd: resolveRuntimeRoot(),
        sessionId
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }

    await removeSessionComposedAgentsFile({
      cwd: resolveRuntimeRoot(),
      sessionId
    });
    process.stdout.write(
      `${JSON.stringify({ session_id: sessionId, removed: true })}\n`
    );
    return;
  }

  if (subcommand !== "hook") {
    console.error(
      "Usage: agmo internal hook | agmo internal agents <compose-session|remove-session> <session-id>"
    );
    process.exitCode = 1;
    return;
  }

  const stdin = await readStdin();
  let payload: HookPayload | null = null;

  if (stdin) {
    try {
      payload = JSON.parse(stdin) as HookPayload;
    } catch {
      payload = null;
    }
  }

  const eventName = resolveHookEvent(args, payload);

  const teamName = process.env.AGMO_TEAM_NAME;
  const workerName = process.env.AGMO_WORKER_NAME;
  if (teamName && workerName && eventName) {
    try {
      await recordWorkerHookActivity(teamName, workerName, eventName, resolveRuntimeRoot());
    } catch (error) {
      console.error(
        `[agmo] failed to record worker hook activity: ${(error as Error).message}`
      );
    }
  }

  if (eventName === "SessionStart") {
    process.stdout.write(
      `${await buildSessionStartContext(
        resolveRuntimeRoot(),
        process.env,
        (payload ?? {}) as Record<string, unknown>
      )}\n`
    );
    return;
  }

  if (eventName === "UserPromptSubmit") {
    const output = await handleUserPromptSubmit({
      cwd: resolveRuntimeRoot(),
      payload: (payload ?? {}) as Record<string, unknown>
    });

    if (output) {
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
    return;
  }

  if (eventName === "PreToolUse") {
    const output = await handlePreToolUse({
      cwd: resolveRuntimeRoot(),
      payload: (payload ?? {}) as Record<string, unknown>
    });

    if (output) {
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
    return;
  }

  if (eventName === "PostToolUse") {
    const output = await handlePostToolUse({
      cwd: resolveRuntimeRoot(),
      payload: (payload ?? {}) as Record<string, unknown>
    });

    if (output) {
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
    return;
  }

  if (eventName === "Stop") {
    const output = await handleStop({
      cwd: resolveRuntimeRoot(),
      payload: (payload ?? {}) as Record<string, unknown>
    });

    if (output) {
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
  }
}
