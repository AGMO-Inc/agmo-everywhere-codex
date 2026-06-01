import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addWisdomEntry } from "../wisdom/store.js";
import { migrateWisdomToWiki } from "./migrate.js";
import { resolveWikiRuntime } from "./runtime.js";

test("migrateWisdomToWiki supports dry-run and idempotent writes without mutating wisdom.json", async () => {
  const cwd = await mkdtemp(join(os.tmpdir(), "agmo-wiki-migrate-"));
  const vault = join(cwd, "vault");
  await mkdir(join(cwd, ".agmo"), { recursive: true });
  await mkdir(vault, { recursive: true });
  await writeFile(join(cwd, ".agmo", "config.json"), JSON.stringify({ vault_root: vault }, null, 2));
  await addWisdomEntry({
    scope: "project",
    kind: "decision",
    content: "Project decision migrates to wiki markdown.",
    cwd
  });
  const wisdomPath = join(cwd, ".agmo", "memory", "wisdom.json");
  const before = await readFile(wisdomPath, "utf8");
  const runtime = await resolveWikiRuntime({ cwd, project: "demo", requireVault: true });
  assert.ok(runtime);

  const dryRun = await migrateWisdomToWiki({ runtime, scope: "project", dryRun: true });
  assert.equal(dryRun.planned.length, 1);
  assert.equal(dryRun.written.length, 0);

  const first = await migrateWisdomToWiki({ runtime, scope: "project", dryRun: false });
  assert.equal(first.written.length, 1);
  const markdown = await readFile(join(vault, "demo", "wisdom", "decisions.md"), "utf8");
  assert.match(markdown, /Project decision migrates to wiki markdown\./);

  const second = await migrateWisdomToWiki({ runtime, scope: "project", dryRun: false });
  assert.equal(second.written.length, 0);
  assert.equal(second.planned[0]?.already_present, true);
  assert.equal(await readFile(wisdomPath, "utf8"), before);
});
