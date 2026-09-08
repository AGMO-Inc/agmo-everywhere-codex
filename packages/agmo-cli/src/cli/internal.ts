import {
  removeSessionComposedAgentsFile,
  writeSessionComposedAgentsFile
} from "../agents/agents-md.js";
import { handlePostToolUse } from "../hooks/post-tool-use.js";
import { handlePreToolUse } from "../hooks/pre-tool-use.js";
import { buildSessionStartContext } from "../hooks/session-start.js";
import { handleStop } from "../hooks/stop.js";
import { handleUserPromptSubmit } from "../hooks/user-prompt-submit.js";
import { managedProjectHookApplies } from "../hooks/codex-hooks.js";
import { recordWorkerHookActivity } from "../team/runtime.js";
import { readTextFileIfExists } from "../utils/fs.js";
import { parseOptionalScopeFlag } from "../utils/args.js";
import { resolveInstallPaths, resolveRuntimeRoot } from "../utils/paths.js";

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
  const positionalArgs: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--scope") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--scope=")) {
      continue;
    }
    positionalArgs.push(arg);
  }
  return (
    positionalArgs[0] ??
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
  const scope = parseOptionalScopeFlag(args.slice(1));
  const runtimeRoot = resolveRuntimeRoot();

  if (scope === "user" && eventName) {
    let projectHooks: string | null = null;
    try {
      projectHooks = await readTextFileIfExists(
        resolveInstallPaths("project", runtimeRoot).hooksFile
      );
    } catch {
      projectHooks = null;
    }
    if (
      managedProjectHookApplies(
        projectHooks,
        eventName,
        (payload ?? {}) as Record<string, unknown>
      )
    ) {
      return;
    }
  }

  const teamName = process.env.AGMO_TEAM_NAME;
  const workerName = process.env.AGMO_WORKER_NAME;
  if (teamName && workerName && eventName) {
    try {
      await recordWorkerHookActivity(teamName, workerName, eventName, runtimeRoot);
    } catch (error) {
      console.error(
        `[agmo] failed to record worker hook activity: ${(error as Error).message}`
      );
    }
  }

  if (eventName === "SessionStart") {
    process.stdout.write(
      `${await buildSessionStartContext(
        runtimeRoot,
        process.env,
        (payload ?? {}) as Record<string, unknown>
      )}\n`
    );
    return;
  }

  if (eventName === "UserPromptSubmit") {
    const output = await handleUserPromptSubmit({
      cwd: runtimeRoot,
      payload: (payload ?? {}) as Record<string, unknown>
    });

    if (output) {
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
    return;
  }

  if (eventName === "PreToolUse") {
    const output = await handlePreToolUse({
      cwd: runtimeRoot,
      payload: (payload ?? {}) as Record<string, unknown>
    });

    if (output) {
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
    return;
  }

  if (eventName === "PostToolUse") {
    const output = await handlePostToolUse({
      cwd: runtimeRoot,
      payload: (payload ?? {}) as Record<string, unknown>
    });

    if (output) {
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
    return;
  }

  if (eventName === "Stop") {
    const output = await handleStop({
      cwd: runtimeRoot,
      payload: (payload ?? {}) as Record<string, unknown>
    });

    if (output) {
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
  }
}
