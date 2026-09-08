import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHookCommand,
  managedProjectHookApplies,
  mergeManagedHooksConfig
} from "./codex-hooks.js";

test("buildHookCommand records the installation scope", () => {
  assert.equal(
    buildHookCommand("/tmp/agmo/dist/cli/index.js", "project"),
    'node "/tmp/agmo/dist/cli/index.js" internal hook --scope project'
  );
  assert.equal(
    buildHookCommand("/tmp/agmo/dist/cli/index.js", "user"),
    'node "/tmp/agmo/dist/cli/index.js" internal hook --scope user'
  );
});

test("managedProjectHookApplies requires a recognized project command and applicable matcher", () => {
  const projectCommand = buildHookCommand("/tmp/agmo/dist/cli/index.js", "project");
  const config = JSON.stringify({
    hooks: {
      SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: projectCommand }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: projectCommand }] }],
      Stop: [{ hooks: [{ type: "command", command: projectCommand }] }]
    }
  });

  assert.equal(managedProjectHookApplies(config, "SessionStart", { source: "resume" }), true);
  assert.equal(managedProjectHookApplies(config, "SessionStart", { source: "compact" }), false);
  assert.equal(managedProjectHookApplies(config, "PreToolUse", { tool_name: "bash" }), true);
  assert.equal(managedProjectHookApplies(config, "PreToolUse", { tool_name: "Read" }), false);
  assert.equal(managedProjectHookApplies(config, "PreToolUse", {}), false);
  assert.equal(managedProjectHookApplies(config, "Stop", {}), true);
  assert.equal(managedProjectHookApplies("not-json", "Stop", {}), false);
});

test("managedProjectHookApplies falls back for malformed entries and handles wildcard and post-tool matchers", () => {
  const projectCommand = buildHookCommand("/tmp/agmo/dist/cli/index.js", "project");
  for (const hooks of [[{}], [null], [{ hooks: [null] }]]) {
    assert.doesNotThrow(() =>
      managedProjectHookApplies(JSON.stringify({ hooks: { Stop: hooks } }), "Stop", {})
    );
    assert.equal(
      managedProjectHookApplies(JSON.stringify({ hooks: { Stop: hooks } }), "Stop", {}),
      false
    );
  }

  const config = JSON.stringify({
    hooks: {
      SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: projectCommand }] }],
      PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: projectCommand }] }]
    }
  });
  assert.equal(managedProjectHookApplies(config, "SessionStart", { source: "anything" }), true);
  assert.equal(managedProjectHookApplies(config, "PostToolUse", { tool_name: "Read" }), false);
  assert.equal(managedProjectHookApplies(config, "PostToolUse", { tool_name: "Bash" }), true);
});

test("mergeManagedHooksConfig replaces legacy hook commands on managed events and preserves unmanaged events", () => {
  const existing = {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume",
          hooks: [
            { type: "command", command: "node \"/tmp/agmo/dist/cli/index.js\" internal hook" },
            { type: "command", command: "node \"/tmp/legacy/dist/scripts/codex-native-hook.js\"" }
          ]
        }
      ],
      UserPromptSubmit: [
        {
          hooks: [
            { type: "command", command: "node \"/tmp/legacy/dist/scripts/codex-native-hook.js\"" }
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

test("mergeManagedHooksConfig preserves unrelated commands that happen to contain internal hook", () => {
  const unrelated = 'node "/tmp/other-tool/index.js" internal hook --scope project';
  const existing = JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: unrelated }] }]
    }
  });
  const merged = JSON.parse(
    mergeManagedHooksConfig(
      existing,
      buildHookCommand("/tmp/agmo/dist/cli/index.js", "project")
    )
  );

  assert.equal(merged.hooks.Stop[0].hooks[0].command, unrelated);
  assert.equal(merged.hooks.Stop[1].hooks[0].command.includes("/tmp/agmo/"), true);
});
