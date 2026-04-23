import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleStop } from "./stop.js";
import { recordSessionAutosave, writeWorkflowActivation } from "./runtime-state.js";
import { readWisdomStore } from "../wisdom/store.js";

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const tempHome = await mkdtemp(join(os.tmpdir(), "agmo-stop-home-"));
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

test("handleStop persists a wisdom outcome once for wisdom workflow", async () => {
  await withTempHome(async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-stop-wisdom-"));
    const payload = {
      session_id: "wisdom-stop-session",
      prompt: "plugin research 요약 정리해줘"
    };

    await writeWorkflowActivation({
      cwd: tempRoot,
      payload,
      workflow: "wisdom",
      reason: "summarize plugin research for future sessions"
    });
    await recordSessionAutosave({
      cwd: tempRoot,
      payload,
      autosaveAt: "2026-04-23T10:00:00.000Z",
      autosaveTrigger: "workflow_change",
      autosaveSignature: "wisdom-note-1",
      autosaveWorkflow: "wisdom",
      noteRef: {
        workflow: "wisdom",
        type: "research",
        title: "Plugin wisdom summary",
        relative_path: "research/plugin-wisdom-summary.md",
        wikilink: "[[demo/research/Plugin wisdom summary]]",
        saved_at: "2026-04-23T10:00:00.000Z"
      }
    });

    await handleStop({ cwd: tempRoot, payload });
    let store = await readWisdomStore("project", tempRoot);

    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].kind, "learn");
    assert.match(store.entries[0].content, /Plugin wisdom summary/);
    assert.match(store.entries[0].content, /\[\[demo\/research\/Plugin wisdom summary\]\]/);

    await handleStop({ cwd: tempRoot, payload });
    store = await readWisdomStore("project", tempRoot);
    assert.equal(store.entries.length, 1);
  });
});
