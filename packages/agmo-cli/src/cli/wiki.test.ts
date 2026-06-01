import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runWikiCommand } from "./wiki.js";

async function captureWikiCommandText(args: string[], cwd: string): Promise<string> {
  const originalCwd = process.cwd();
  const originalProjectRoot = process.env.AGMO_PROJECT_ROOT;
  const originalHome = process.env.HOME;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const stdoutChunks: string[] = [];

  process.env.AGMO_PROJECT_ROOT = cwd;
  process.env.HOME = join(cwd, "home");
  process.chdir(cwd);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as typeof process.stdout.write;

  try {
    await runWikiCommand(args);
  } finally {
    process.stdout.write = originalWrite;
    process.chdir(originalCwd);
    if (originalProjectRoot === undefined) {
      delete process.env.AGMO_PROJECT_ROOT;
    } else {
      process.env.AGMO_PROJECT_ROOT = originalProjectRoot;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  return stdoutChunks.join("");
}

test("runWikiCommand context defaults to manifest and rejects invalid explicit budget", async () => {
  const cwd = await mkdtemp(join(os.tmpdir(), "agmo-wiki-cli-"));
  const vault = join(cwd, "vault");
  await mkdir(join(vault, ".agmo", "llm-wiki", "projects", "demo", "captures"), { recursive: true });
  await mkdir(join(cwd, ".agmo"), { recursive: true });
  await writeFile(join(cwd, ".agmo", "config.json"), JSON.stringify({ vault_root: vault }, null, 2));
  await writeFile(
    join(vault, ".agmo", "llm-wiki", "projects", "demo", "captures", "capture.md"),
    "---\ntitle: CLI Capture\n---\n# Capture\nFull body should require --full\n"
  );

  const output = await captureWikiCommandText(
    ["context", "--project", "demo"],
    cwd
  );

  assert.match(output, /LLM Wiki Manifest/);
  assert.match(output, /CLI Capture/);
  assert.doesNotMatch(output, /Full body should require --full/);

  const fullOutput = await captureWikiCommandText(
    ["context", "--project", "demo", "--full"],
    cwd
  );
  assert.match(fullOutput, /LLM Wiki Context/);
  assert.match(fullOutput, /Full body should require --full/);

  await assert.rejects(
    () => captureWikiCommandText(["context", "--project", "demo", "--full", "--budget", "0"], cwd),
    /--budget must be a positive integer/
  );
});
