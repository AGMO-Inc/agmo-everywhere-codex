import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handlePostToolUse } from "./post-tool-use.js";
import { writeWorkflowActivation } from "./runtime-state.js";
import { readWisdomStore } from "../wisdom/store.js";

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const tempHome = await mkdtemp(join(os.tmpdir(), "agmo-post-tool-home-"));
  process.env.HOME = tempHome;

  try {
    return await fn();
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
}

test("handlePostToolUse persists save-note outcomes into project wisdom store", async () => {
  await withTempHome(async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-post-tool-wisdom-"));
    const payload = {
      session_id: "save-note-session",
      prompt: "결정사항 저장해줘"
    };

    await writeWorkflowActivation({
      cwd: tempRoot,
      payload,
      workflow: "save-note",
      reason: "record the decision about removing legacy runtime dependencies"
    });

    await handlePostToolUse({
      cwd: tempRoot,
      payload: {
        ...payload,
        tool_name: "Write",
        success: true,
        output: "saved durable note summary"
      }
    });

    const store = await readWisdomStore("project", tempRoot);
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].kind, "decision");
    assert.match(store.entries[0].content, /record the decision about removing legacy runtime dependencies/i);
  });
});


test("handlePostToolUse persists vault-search outcomes using tool summaries", async () => {
  await withTempHome(async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-post-tool-vault-search-"));
    const payload = {
      session_id: "vault-search-session",
      prompt: "이전 결정 문서 찾아줘"
    };

    await writeWorkflowActivation({
      cwd: tempRoot,
      payload,
      workflow: "vault-search",
      reason: "knowledge/doc/research-oriented request"
    });

    await handlePostToolUse({
      cwd: tempRoot,
      payload: {
        ...payload,
        tool_name: "Search",
        success: true,
        output: "Found previous implementation note and design decision"
      }
    });

    const store = await readWisdomStore("project", tempRoot);
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].kind, "decision");
    assert.match(store.entries[0].content, /Found previous implementation note and design decision/);
  });
});
