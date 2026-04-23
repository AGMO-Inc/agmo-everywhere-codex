import assert from "node:assert/strict";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  addWisdomEntry,
  persistSessionWisdomOutcome,
  readEffectiveWisdom,
  readWisdomStore,
  resetWisdomStore,
  resolveWisdomStorePath
} from "./store.js";

async function withTempHome<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const tempHome = await mkdtemp(join(os.tmpdir(), "agmo-wisdom-home-"));
  process.env.HOME = tempHome;

  try {
    return await fn(tempHome);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
}

test("wisdom store keeps scoped entries and merges effective summary", async () => {
  await withTempHome(async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-wisdom-project-"));

    await addWisdomEntry({
      scope: "user",
      kind: "learn",
      content: "Global preference: keep CLI JSON-first.",
      cwd: tempRoot
    });
    await addWisdomEntry({
      scope: "project",
      kind: "decision",
      content: "Project decision: session start should load project wisdom.",
      cwd: tempRoot
    });
    await addWisdomEntry({
      scope: "project",
      kind: "issue",
      content: "Open issue: remove startup dependency from runtime bootstrap path.",
      cwd: tempRoot
    });

    const project = await readWisdomStore("project", tempRoot);
    const effective = await readEffectiveWisdom(tempRoot);

    assert.equal(project.entries.length, 2);
    assert.equal(effective.user.entries.length, 1);
    assert.equal(effective.project.entries.length, 2);
    assert.equal(effective.merged.length, 3);
    assert.match(project.path, /\.agmo\/memory\/wisdom\.json$/);
    assert.match(resolveWisdomStorePath("user", tempRoot), /\.agmo\/memory\/wisdom\.json$/);
  });
});

test("wisdom reset clears a scoped store", async () => {
  await withTempHome(async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-wisdom-reset-"));

    await addWisdomEntry({
      scope: "project",
      kind: "decision",
      content: "A temporary decision.",
      cwd: tempRoot
    });

    const resetResult = await resetWisdomStore({ scope: "project", cwd: tempRoot });
    const project = await readWisdomStore("project", tempRoot);

    assert.equal(resetResult.entry_count, 0);
    assert.equal(project.entries.length, 0);
  });
});


test("persistSessionWisdomOutcome accepts vault-search and prefers tool summary over generic reason", async () => {
  await withTempHome(async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-wisdom-vault-search-"));

    const result = await persistSessionWisdomOutcome({
      cwd: tempRoot,
      trigger: "post_tool_use_success",
      sessionState: {
        version: 1,
        session_id: "vault-search-session",
        active: true,
        last_event: "PostToolUse",
        workflow: "vault-search",
        workflow_reason: "knowledge/doc/research-oriented request",
        prompt_excerpt: "이전 구현 노트 찾아서 요약해줘",
        last_tool_name: "Search",
        last_tool_status: "succeeded",
        last_tool_summary: "Found previous implementation note and design decision",
        updated_at: "2026-04-23T10:00:00.000Z"
      }
    });

    assert.ok(result);
    assert.equal(result.entry.kind, "decision");
    assert.match(result.entry.content, /Found previous implementation note and design decision/);
    assert.doesNotMatch(result.entry.content, /^knowledge\/doc\/research-oriented request$/);
  });
});
