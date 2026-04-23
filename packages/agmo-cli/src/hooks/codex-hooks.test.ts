import assert from "node:assert/strict";
import test from "node:test";
import { mergeManagedHooksConfig } from "./codex-hooks.js";

test("mergeManagedHooksConfig replaces legacy OMX hooks on managed events and preserves unmanaged events", () => {
  const existing = {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume",
          hooks: [
            { type: "command", command: "node \"/tmp/agmo/dist/cli/index.js\" internal hook" },
            { type: "command", command: "node \"/tmp/omx/dist/scripts/codex-native-hook.js\"" }
          ]
        }
      ],
      UserPromptSubmit: [
        {
          hooks: [
            { type: "command", command: "node \"/tmp/omx/dist/scripts/codex-native-hook.js\"" }
          ]
        }
      ],
      Stop: [
        {
          hooks: [
            { type: "command", command: "node \"/tmp/agmo/dist/cli/index.js\" internal hook", timeout: 30 }
          ]
        }
      ],
      Notification: [
        {
          hooks: [
            { type: "command", command: "echo keep-me" }
          ]
        }
      ]
    }
  };

  const merged = JSON.parse(
    mergeManagedHooksConfig(JSON.stringify(existing, null, 2), 'node \"/tmp/new-agmo/dist/cli/index.js\" internal hook')
  );

  assert.equal(merged.hooks.SessionStart.length, 1);
  assert.equal(merged.hooks.UserPromptSubmit.length, 1);
  assert.equal(merged.hooks.Stop.length, 1);
  assert.equal(merged.hooks.SessionStart[0].hooks.length, 1);
  assert.match(merged.hooks.SessionStart[0].hooks[0].command, /new-agmo/);
  assert.doesNotMatch(JSON.stringify(merged.hooks.SessionStart), /codex-native-hook/);
  assert.doesNotMatch(JSON.stringify(merged.hooks.UserPromptSubmit), /codex-native-hook/);
  assert.equal(merged.hooks.Notification[0].hooks[0].command, "echo keep-me");
});
