import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createVaultNote } from "./runtime.js";

async function withVaultRoot<T>(vaultRoot: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.AGMO_VAULT_ROOT;
  process.env.AGMO_VAULT_ROOT = vaultRoot;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.AGMO_VAULT_ROOT;
    } else {
      process.env.AGMO_VAULT_ROOT = previous;
    }
  }
}

test("createVaultNote keeps project-root vaults flat and links the project index cleanly", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-vault-project-root-"));
  const project = "demo-project";
  const projectRoot = join(tempRoot, project);
  await mkdir(projectRoot, { recursive: true });

  await withVaultRoot(projectRoot, async () => {
    const result = await createVaultNote(
      {
        type: "impl",
        project,
        title: "Vault 품질 개선",
        index: true
      },
      projectRoot
    );

    assert.equal(
      result.vault.path,
      join(projectRoot, "implementations", "[Impl] Vault 품질 개선.md")
    );
    assert.equal(
      result.vault.relative_path,
      join("implementations", "[Impl] Vault 품질 개선.md")
    );
    assert.equal(result.vault.project_wikilink, "[[demo-project]]");

    const note = await readFile(result.vault.path, "utf8");
    assert.match(note, /project_note: "\[\[demo-project\]\]"/);
    assert.match(note, /> Project Index: \[\[demo-project\]\]/);

    const indexNote = await readFile(join(projectRoot, "demo-project.md"), "utf8");
    assert.match(
      indexNote,
      /- \[\[demo-project\/implementations\/\[Impl\] Vault 품질 개선\]\]/
    );
  });
});

test("createVaultNote nests notes only when the configured vault root is shared across projects", async () => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "agmo-vault-shared-root-"));
  const project = "demo-project";

  await withVaultRoot(tempRoot, async () => {
    const result = await createVaultNote(
      {
        type: "memo",
        project,
        title: "Shared Vault Note",
        index: true
      },
      tempRoot
    );

    assert.equal(
      result.vault.path,
      join(tempRoot, project, "memos", "[Memo] Shared Vault Note.md")
    );
    assert.equal(
      result.vault.relative_path,
      join(project, "memos", "[Memo] Shared Vault Note.md")
    );
    assert.equal(result.vault.project_wikilink, "[[demo-project/demo-project]]");

    const note = await readFile(result.vault.path, "utf8");
    assert.match(note, /project_note: "\[\[demo-project\/demo-project\]\]"/);
  });
});
