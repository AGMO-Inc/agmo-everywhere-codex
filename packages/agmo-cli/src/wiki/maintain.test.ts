import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditWiki } from "./maintain.js";
import { resolveWikiRuntime } from "./runtime.js";

test("auditWiki reports stale, low-confidence, contested, superseded, missing frontmatter, and broken links", async () => {
  const cwd = await mkdtemp(join(os.tmpdir(), "agmo-wiki-maintain-"));
  const vault = join(cwd, "vault");
  const captures = join(vault, ".agmo", "llm-wiki", "projects", "demo", "captures");
  await mkdir(captures, { recursive: true });
  await mkdir(join(cwd, ".agmo"), { recursive: true });
  await writeFile(join(cwd, ".agmo", "config.json"), JSON.stringify({ vault_root: vault }, null, 2));
  await writeFile(
    join(vault, ".agmo", "llm-wiki", "projects", "demo.md"),
    "---\nupdated: 2020-01-01\n---\n# Demo\n"
  );
  await writeFile(join(captures, "missing.md"), "# Missing frontmatter\n[[does-not-exist]]\n");
  await writeFile(
    join(captures, "old.md"),
    "---\ntitle: Old\nconfidence: low\ncontested: true\ncreated: 2020-01-01\n---\n# Old\n"
  );
  await writeFile(
    join(captures, "new.md"),
    "---\ntitle: New\nsupersedes: old.md\n---\n# New\n"
  );

  const runtime = await resolveWikiRuntime({ cwd, project: "demo", requireVault: true });
  assert.ok(runtime);
  const result = await auditWiki({
    runtime,
    maxAgeDays: 30,
    now: new Date("2026-06-01T00:00:00Z")
  });
  const kinds = new Set(result.issues.map((issue) => issue.kind));

  assert.ok(kinds.has("STALE"));
  assert.ok(kinds.has("LOW_CONFIDENCE"));
  assert.ok(kinds.has("CONTESTED"));
  assert.ok(kinds.has("SUPERSEDED"));
  assert.ok(kinds.has("MISSING_FRONTMATTER"));
  assert.ok(kinds.has("BROKEN_WIKILINK"));
});
