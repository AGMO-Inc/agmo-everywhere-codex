import assert from "node:assert/strict";
import os from "node:os";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runVaultCommand } from "./vault.js";

async function captureVaultCommandText(args: string[], cwd: string): Promise<string> {
  const originalCwd = process.cwd();
  const originalProjectRoot = process.env.AGMO_PROJECT_ROOT;
  const originalVaultRoot = process.env.AGMO_VAULT_ROOT;
  const originalHome = process.env.HOME;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const stdoutChunks: string[] = [];

  process.env.AGMO_PROJECT_ROOT = cwd;
  process.env.HOME = join(cwd, "home");
  delete process.env.AGMO_VAULT_ROOT;
  process.chdir(cwd);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as typeof process.stdout.write;

  try {
    await runVaultCommand(args);
  } finally {
    process.stdout.write = originalWrite;
    process.chdir(originalCwd);
    if (originalProjectRoot === undefined) {
      delete process.env.AGMO_PROJECT_ROOT;
    } else {
      process.env.AGMO_PROJECT_ROOT = originalProjectRoot;
    }
    if (originalVaultRoot === undefined) {
      delete process.env.AGMO_VAULT_ROOT;
    } else {
      process.env.AGMO_VAULT_ROOT = originalVaultRoot;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  return stdoutChunks.join("");
}

async function captureVaultCommand(
  args: string[],
  cwd: string
): Promise<Record<string, unknown>> {
  return JSON.parse(await captureVaultCommandText(args, cwd)) as Record<string, unknown>;
}

function assertVaultEnvelope(output: Record<string, unknown>, operation: string): void {
  assert.equal(output.schema_version, "1.0");
  assert.equal(output.operation, operation);
  assert.equal(output.ok, true);
}

test("runVaultCommand config show prints the shared machine JSON envelope", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-vault-cli-config-show-"));
  await mkdir(join(tempProject, ".agmo"), { recursive: true });

  const output = await captureVaultCommand(["config", "show"], tempProject);

  assertVaultEnvelope(output, "vault.config.show");
  assert.equal(output.command, "vault config show");
  assert.equal(output.vault_root, null);
  assert.equal(output.source, "none");
  assert.ok(Array.isArray(output.checked_paths));
});

test("runVaultCommand config set-root preserves existing fields inside the envelope", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-vault-cli-config-set-root-"));
  const vaultRoot = join(tempProject, "vault");

  const output = await captureVaultCommand(
    ["config", "set-root", vaultRoot, "--scope", "project"],
    tempProject
  );

  assertVaultEnvelope(output, "vault.config.set-root");
  assert.equal(output.command, "vault config set-root");
  assert.equal(output.scope, "project");
  assert.equal(output.vault_root, vaultRoot);
  assert.equal(output.config_path, join(tempProject, ".agmo", "config.json"));
});

test("runVaultCommand scaffold with output prints the envelope and writes markdown", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-vault-cli-scaffold-output-"));
  const outputPath = join(tempProject, "scaffold.md");

  const output = await captureVaultCommand(
    [
      "scaffold",
      "--type",
      "plan",
      "--project",
      "demo",
      "--title",
      "Envelope Test",
      "--output",
      outputPath
    ],
    tempProject
  );
  const markdown = await readFile(outputPath, "utf8");

  assertVaultEnvelope(output, "vault.scaffold");
  assert.equal(output.command, "vault scaffold");
  assert.equal(output.title, "Envelope Test");
  assert.deepEqual(output.output, { path: outputPath, status: "created" });
  assert.match(markdown, /^---\n/);
  assert.match(markdown, /^# Envelope Test$/m);
});

test("runVaultCommand save and create print the shared machine JSON envelope", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-vault-cli-save-create-"));
  const vaultRoot = join(tempProject, "vault");
  const sourceFile = join(tempProject, "note.md");
  await mkdir(vaultRoot, { recursive: true });
  await writeFile(sourceFile, "# Saved Note\n", "utf8");
  await captureVaultCommand(["config", "set-root", vaultRoot, "--scope", "project"], tempProject);

  const saveOutput = await captureVaultCommand(
    [
      "save",
      "--type",
      "impl",
      "--project",
      "demo",
      "--title",
      "Saved Envelope",
      "--file",
      sourceFile
    ],
    tempProject
  );
  const createOutput = await captureVaultCommand(
    [
      "create",
      "--type",
      "memo",
      "--project",
      "demo",
      "--title",
      "Created Envelope"
    ],
    tempProject
  );

  assertVaultEnvelope(saveOutput, "vault.save");
  assert.equal(saveOutput.command, "vault save");
  assert.equal(saveOutput.created, true);
  assert.equal(saveOutput.duplicate, false);
  assert.match(String(saveOutput.relative_path), /implementations/);

  assertVaultEnvelope(createOutput, "vault.create");
  assert.equal(createOutput.command, "vault create");
  assert.equal(createOutput.created, true);
  assert.equal(createOutput.duplicate, false);
  assert.equal(createOutput.scaffold_title, "Created Envelope");
});

test("runVaultCommand scaffold without output preserves plain markdown stdout", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-vault-cli-scaffold-plain-"));

  const output = await captureVaultCommandText(
    ["scaffold", "--type", "plan", "--project", "demo", "--title", "Plain Output"],
    tempProject
  );

  assert.throws(() => JSON.parse(output));
  assert.match(output, /^---\n/);
  assert.match(output, /^# Plain Output$/m);
  assert.equal(output.includes("schema_version"), false);
});
