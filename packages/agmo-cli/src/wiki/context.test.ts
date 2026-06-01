import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_MANIFEST_BUDGET_CHARS,
  renderWikiContext
} from "./context.js";
import { resolveWikiRuntime, sanitizeWikiName } from "./runtime.js";

async function withWikiFixture<T>(fn: (args: { cwd: string; vault: string }) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(os.tmpdir(), "agmo-wiki-context-"));
  const vault = join(cwd, "vault");
  const wiki = join(vault, ".agmo", "llm-wiki");
  await mkdir(join(wiki, "projects", "demo", "captures"), { recursive: true });
  await mkdir(join(wiki, "projects", "other", "captures"), { recursive: true });
  await writeFile(join(wiki, "SCHEMA.md"), "# Schema\nSchema body\n");
  await writeFile(join(wiki, "INDEX.md"), "# Index\nIndex body\n");
  await writeFile(join(wiki, "LOG.md"), "# Log\nRecent log\n");
  await writeFile(
    join(wiki, "projects", "demo.md"),
    "---\ntitle: Demo Capsule\nupdated: 2026-05-31\n---\n# Demo\nCapsule body\n"
  );
  await writeFile(
    join(wiki, "projects", "demo", "captures", "old.md"),
    "---\ntitle: Old Capture\n---\n# Old\nOld body must not be injected\n"
  );
  await writeFile(
    join(wiki, "projects", "demo", "captures", "new.md"),
    "---\ntitle: New Capture\nsupersedes: old.md\n---\n# New\nNew body\n"
  );
  await writeFile(
    join(wiki, "projects", "demo", "captures", "top.md"),
    "---\ntitle: Top Capture\n---\n# Top\nTop body\n"
  );
  await writeFile(join(wiki, "projects", "other", "captures", "note.md"), "# Other\n");
  await mkdir(join(cwd, ".agmo"), { recursive: true });
  await writeFile(join(cwd, ".agmo", "config.json"), JSON.stringify({ vault_root: vault }, null, 2));

  return await fn({ cwd, vault });
}

test("manifest context is metadata-only, capped, and lists top titles plus other projects", async () => {
  await withWikiFixture(async ({ cwd }) => {
    const runtime = await resolveWikiRuntime({ cwd, project: "demo", requireVault: true });
    assert.ok(runtime);

    const output = await renderWikiContext({
      runtime,
      mode: "manifest",
      budgetChars: DEFAULT_MANIFEST_BUDGET_CHARS
    });

    assert.ok(output.length <= DEFAULT_MANIFEST_BUDGET_CHARS);
    assert.match(output, /Top Capture|New Capture|Old Capture/);
    assert.match(output, /Other Projects/);
    assert.match(output, /other \(1\)/);
    assert.doesNotMatch(output, /Old body must not be injected/);
  });
});

test("full json context honors budget metadata and excludes superseded captures", async () => {
  await withWikiFixture(async ({ cwd }) => {
    const runtime = await resolveWikiRuntime({ cwd, project: "demo", requireVault: true });
    assert.ok(runtime);

    const output = await renderWikiContext({
      runtime,
      mode: "full",
      format: "json",
      budgetChars: 12000
    });
    const parsed = JSON.parse(output) as {
      mode: string;
      budget_chars: number;
      included: Array<{ content: string; path: string }>;
      omitted: Array<{ reason: string; path: string }>;
    };

    assert.equal(parsed.mode, "full");
    assert.equal(parsed.budget_chars, 12000);
    assert.ok(parsed.included.some((entry) => entry.content.includes("New body")));
    assert.ok(parsed.omitted.some((entry) => entry.reason === "superseded" && entry.path.endsWith("old.md")));
    assert.equal(parsed.included.some((entry) => entry.content.includes("Old body must not be injected")), false);
  });
});

test("full markdown context is capped after omitted summaries are rendered", async () => {
  await withWikiFixture(async ({ cwd }) => {
    const runtime = await resolveWikiRuntime({ cwd, project: "demo", requireVault: true });
    assert.ok(runtime);

    const output = await renderWikiContext({
      runtime,
      mode: "full",
      budgetChars: 240
    });

    assert.ok(output.length <= 240);
  });
});

test("wiki project names cannot resolve to relative path segments", () => {
  assert.throws(() => sanitizeWikiName(".."), /relative path segment/);
  assert.throws(() => sanitizeWikiName("."), /relative path segment/);
});
