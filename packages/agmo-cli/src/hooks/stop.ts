import { removeSessionComposedAgentsFile } from "../agents/agents-md.js";
import { saveSessionCheckpointNote } from "../vault/checkpoint.js";
import { resolveVaultRoot } from "../vault/runtime.js";
import { persistSessionWisdomOutcome } from "../wisdom/store.js";
import { readOptionalSessionId } from "./runtime-state.js";
import {
  markSessionStopped,
  readPersistedSessionState,
  type AgmoHookPayload
} from "./runtime-state.js";

export async function handleStop(args: {
  cwd: string;
  payload: AgmoHookPayload;
}): Promise<null> {
  await markSessionStopped(args);
  const stoppedState = await readPersistedSessionState(args);
  const sessionId = readOptionalSessionId(args.payload);

  if (stoppedState) {
    const vault = await resolveVaultRoot(args.cwd);
    if (vault.vault_root && vault.source !== "none") {
      try {
        await saveSessionCheckpointNote({
          cwd: args.cwd,
          trigger: "stop",
          sessionState: stoppedState
        });
      } catch (error) {
        // Stop hooks have a strict output contract. Keep autosave best-effort
        // and silent so session teardown never fails because note persistence did.
        void error;
      }
    }

    try {
      const persistedState = (await readPersistedSessionState(args)) ?? stoppedState;
      await persistSessionWisdomOutcome({
        cwd: args.cwd,
        sessionState: persistedState,
        trigger: "stop"
      });
    } catch (error) {
      void error;
    }
  }

  if (sessionId) {
    await removeSessionComposedAgentsFile({
      cwd: args.cwd,
      sessionId
    });
  }

  return null;
}
