import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInternalCommand } from "./internal.js";
import { resolveInstallPaths } from "../utils/paths.js";

async function withIsolatedEnv<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
  const originalProjectRoot = process.env.AGMO_PROJECT_ROOT;
  const originalHome = process.env.HOME;
  const originalCodexHome = process.env.CODEX_HOME;
  process.env.AGMO_PROJECT_ROOT = projectRoot;
  process.env.HOME = await mkdtemp(join(os.tmpdir(), "agmo-internal-home-"));
  process.env.CODEX_HOME = await mkdtemp(join(os.tmpdir(), "agmo-internal-codex-"));

  try {
    return await fn();
  } finally {
    restoreEnv("AGMO_PROJECT_ROOT", originalProjectRoot);
    restoreEnv("HOME", originalHome);
    restoreEnv("CODEX_HOME", originalCodexHome);
  }
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
    return true;
  }) as typeof process.stdout.write;

  try {
    await fn();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function runHookCli(args: string[], payload = ""): Promise<string> {
  const cliPath = new URL("./index.js", import.meta.url);
  const child = spawn(process.execPath, [cliPath.pathname, "internal", ...args], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(payload);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  assert.equal(exitCode, 0, stderr);
  return stdout;
}

test("internal agents compose-session emits empty union JSON without creating an artifact", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "agmo-internal-compose-"));
  await withIsolatedEnv(projectRoot, async () => {
    const output = await captureStdout(async () => {
      await runInternalCommand(["agents", "compose-session", "empty-session"]);
    });
    const sessionFile = join(
      resolveInstallPaths("project", projectRoot).sessionInstructionsDir,
      "empty-session",
      "AGENTS.md"
    );

    assert.deepEqual(JSON.parse(output), {
      kind: "empty",
      removed: "absent",
      sources: {}
    });
    assert.equal(existsSync(sessionFile), false);
  });
});

test("internal agents remove-session removes valid session artifacts", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "agmo-internal-remove-"));
  await withIsolatedEnv(projectRoot, async () => {
    const sessionDir = join(
      resolveInstallPaths("project", projectRoot).sessionInstructionsDir,
      "valid-session"
    );
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "AGENTS.md"), "stale\n", "utf-8");

    const output = await captureStdout(async () => {
      await runInternalCommand(["agents", "remove-session", "valid-session"]);
    });

    assert.deepEqual(JSON.parse(output), {
      session_id: "valid-session",
      removed: true
    });
    assert.equal(existsSync(sessionDir), false);
  });
});

test("internal agents remove-session rejects traversal-like ids before filesystem mutation", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "agmo-internal-invalid-"));
  await withIsolatedEnv(projectRoot, async () => {
    const sentinel = join(projectRoot, ".agmo", "cache", "sentinel");
    await mkdir(join(projectRoot, ".agmo", "cache"), { recursive: true });
    await writeFile(sentinel, "keep\n", "utf-8");

    await assert.rejects(
      captureStdout(async () => {
        await runInternalCommand(["agents", "remove-session", "../sentinel"]);
      }),
      /invalid session id/
    );
    assert.equal(existsSync(sentinel), true);
  });
});

test("user-scoped hook runs when no applicable project registration exists", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "agmo-internal-user-fallback-"));
  await withIsolatedEnv(projectRoot, async () => {
    const output = await runHookCli(
      ["hook", "--scope", "user", "SessionStart"],
      JSON.stringify({ source: "startup" })
    );
    assert.match(output, /Agmo session bootstrap active/);
  });
});

test("user-scoped hook yields to an applicable project registration before side effects", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "agmo-internal-project-owner-"));
  await withIsolatedEnv(projectRoot, async () => {
    const hooksFile = resolveInstallPaths("project", projectRoot).hooksFile;
    await mkdir(join(hooksFile, ".."), { recursive: true });
    await writeFile(
      hooksFile,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "startup|resume",
              hooks: [
                {
                  type: "command",
                  command: 'node "/tmp/agmo/dist/cli/index.js" internal hook --scope project'
                }
              ]
            }
          ]
        }
      }),
      "utf8"
    );

    const output = await runHookCli(
      ["hook", "--scope", "user", "SessionStart"],
      JSON.stringify({ source: "startup" })
    );
    assert.equal(output, "");
  });
});

test("explicit positional hook event remains compatible with scope flags", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "agmo-internal-positional-event-"));
  await withIsolatedEnv(projectRoot, async () => {
    const output = await runHookCli(["hook", "SessionStart", "--scope", "project"]);
    assert.match(output, /Agmo session bootstrap active/);
  });
});
