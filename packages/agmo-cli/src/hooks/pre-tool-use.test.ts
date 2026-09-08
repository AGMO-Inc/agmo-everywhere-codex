import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handlePreToolUse } from "./pre-tool-use.js";
import { readPersistedSessionState } from "./runtime-state.js";

test("PreToolUse detects risky command tails before truncating the stored summary", async () => {
  const cases = [
    { command: `${"safe ".repeat(60)}rm -rf /tmp/example` },
    { tool_input: { cmd: `${"safe ".repeat(60)}git reset --hard HEAD` } },
    { tool_input: { command: `${"safe ".repeat(60)}git clean -fd` } }
  ];

  for (const [index, input] of cases.entries()) {
    const root = await mkdtemp(join(os.tmpdir(), "agmo-pre-tool-risk-tail-"));
    const payload = {
      session_id: `risk-tail-${index}`,
      tool_name: "Bash",
      ...input
    };
    const result = await handlePreToolUse({ cwd: root, payload });
    assert.ok(result, `case ${index} should be flagged`);
    assert.match(result.hookSpecificOutput.additionalContext, /flagged this tool call as high risk/);

    const state = await readPersistedSessionState({ cwd: root, payload });
    assert.ok((state?.last_tool_summary?.length ?? 0) <= 220);
  }
});

test("PreToolUse leaves safe long input unflagged while capping its summary", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "agmo-pre-tool-safe-long-"));
  const payload = {
    session_id: "safe-long",
    tool_name: "Bash",
    tool_input: { command: "safe-command ".repeat(80) }
  };

  assert.equal(await handlePreToolUse({ cwd: root, payload }), null);
  const state = await readPersistedSessionState({ cwd: root, payload });
  assert.equal(state?.last_tool_summary?.length, 220);
});
