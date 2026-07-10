import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MANUAL_END,
  MANUAL_START,
  GENERATED_END,
  GENERATED_START,
  MANAGED_MARKER,
  removeSessionComposedAgentsFile,
  writeSessionComposedAgentsFile
} from "./agents-md.js";
import { resolveInstallPaths } from "../utils/paths.js";

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const originalCodexHome = process.env.CODEX_HOME;
  process.env.HOME = await mkdtempPath("agmo-agents-home-");
  process.env.CODEX_HOME = await mkdtempPath("agmo-agents-codex-");

  try {
    return await fn();
  } finally {
    restoreEnv("HOME", originalHome);
    restoreEnv("CODEX_HOME", originalCodexHome);
  }
}

async function mkdtempPath(prefix: string): Promise<string> {
  return await mkdtemp(join(os.tmpdir(), prefix));
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function managedAgentsContent(args: {
  generated?: string;
  manual?: string;
} = {}): string {
  return [
    MANAGED_MARKER,
    GENERATED_START,
    args.generated ?? "",
    GENERATED_END,
    MANUAL_START,
    args.manual ?? "",
    MANUAL_END
  ].join("\n");
}

test("writeSessionComposedAgentsFile returns empty and creates no artifact when no sources or overlays exist", async () => {
  await withTempHome(async () => {
    const projectRoot = await mkdtempPath("agmo-agents-empty-");
    const sessionId = "empty-session";
    const result = await writeSessionComposedAgentsFile({
      cwd: projectRoot,
      sessionId
    });
    const sessionDir = join(
      resolveInstallPaths("project", projectRoot).sessionInstructionsDir,
      sessionId
    );

    assert.deepEqual(result, {
      kind: "empty",
      removed: "absent",
      sources: {}
    });
    assert.equal(existsSync(join(sessionDir, "AGENTS.md")), false);
    assert.equal(existsSync(sessionDir), false);
  });
});

test("empty composition removes only stale same-session artifacts", async () => {
  await withTempHome(async () => {
    const projectRoot = await mkdtempPath("agmo-agents-stale-");
    const paths = resolveInstallPaths("project", projectRoot);
    const sessionDir = join(paths.sessionInstructionsDir, "target-session");
    const siblingDir = join(paths.sessionInstructionsDir, "sibling-session");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(siblingDir, { recursive: true });
    await writeFile(join(sessionDir, "AGENTS.md"), "stale\n", "utf-8");
    await writeFile(join(siblingDir, "AGENTS.md"), "keep\n", "utf-8");

    const result = await writeSessionComposedAgentsFile({
      cwd: projectRoot,
      sessionId: "target-session"
    });

    assert.equal(result.kind, "empty");
    assert.equal(result.removed, "removed");
    assert.equal(existsSync(sessionDir), false);
    assert.equal(existsSync(join(siblingDir, "AGENTS.md")), true);
  });
});

test("invalid session ids are rejected before write or removal can escape the session root", async () => {
  await withTempHome(async () => {
    const projectRoot = await mkdtempPath("agmo-agents-invalid-");
    const sentinel = join(projectRoot, ".agmo", "cache", "outside-sentinel");
    await mkdir(join(projectRoot, ".agmo", "cache"), { recursive: true });
    await writeFile(sentinel, "keep\n", "utf-8");
    await writeFile(join(projectRoot, "AGENTS.md"), "# Project\n", "utf-8");

    for (const sessionId of ["", "/absolute", "..", "../escape", "nested/session", "nested\\session"]) {
      await assert.rejects(
        writeSessionComposedAgentsFile({ cwd: projectRoot, sessionId }),
        /invalid session id/
      );
      await assert.rejects(
        removeSessionComposedAgentsFile({ cwd: projectRoot, sessionId }),
        /invalid session id/
      );
    }

    assert.equal(await readFile(sentinel, "utf-8"), "keep\n");
  });
});

test("empty or non-composable source files still report sources without leaving artifacts", async () => {
  await withTempHome(async () => {
    const projectRoot = await mkdtempPath("agmo-agents-empty-sources-");
    const userAgentsPath = join(process.env.CODEX_HOME ?? "", "AGENTS.md");
    const projectAgentsPath = join(projectRoot, "AGENTS.md");
    await mkdir(process.env.CODEX_HOME ?? "", { recursive: true });
    await writeFile(userAgentsPath, "   \n", "utf-8");
    await writeFile(projectAgentsPath, managedAgentsContent(), "utf-8");

    const result = await writeSessionComposedAgentsFile({
      cwd: projectRoot,
      sessionId: "empty-sources"
    });
    const sessionDir = join(
      resolveInstallPaths("project", projectRoot).sessionInstructionsDir,
      "empty-sources"
    );

    assert.deepEqual(result, {
      kind: "empty",
      removed: "absent",
      sources: {
        user_agents_md: userAgentsPath,
        project_agents_md: projectAgentsPath
      }
    });
    assert.equal(existsSync(sessionDir), false);
  });
});

test("nonempty user or project content writes composed AGENTS with sources", async () => {
  await withTempHome(async () => {
    const projectRoot = await mkdtempPath("agmo-agents-written-");
    const userAgentsPath = join(process.env.CODEX_HOME ?? "", "AGENTS.md");
    const projectAgentsPath = join(projectRoot, "AGENTS.md");
    await mkdir(process.env.CODEX_HOME ?? "", { recursive: true });
    await writeFile(userAgentsPath, "# User\n", "utf-8");
    await writeFile(projectAgentsPath, "# Project\n", "utf-8");

    const result = await writeSessionComposedAgentsFile({
      cwd: projectRoot,
      sessionId: "written-session"
    });

    assert.equal(result.kind, "written");
    assert.equal(result.status, "created");
    assert.deepEqual(result.sources, {
      user_agents_md: userAgentsPath,
      project_agents_md: projectAgentsPath
    });
    assert.match(await readFile(result.path, "utf-8"), /# User\n\n# Project\n/);
  });
});

test("nonempty runtime or worker overlays write even when source files are absent", async () => {
  await withTempHome(async () => {
    const projectRoot = await mkdtempPath("agmo-agents-overlays-");

    const runtime = await writeSessionComposedAgentsFile({
      cwd: projectRoot,
      sessionId: "runtime-overlay",
      runtimeOverlay: "runtime body"
    });
    const worker = await writeSessionComposedAgentsFile({
      cwd: projectRoot,
      sessionId: "worker-overlay",
      workerOverlay: "worker body"
    });

    assert.equal(runtime.kind, "written");
    assert.equal(worker.kind, "written");
  });
});
