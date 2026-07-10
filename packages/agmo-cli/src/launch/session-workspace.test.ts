import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  cleanupLaunchWorkspaces,
  cloneGitWorkspace,
  prepareSessionWorkspace
} from "./session-workspace.js";
import { resolveInstallPaths } from "../utils/paths.js";

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

test("cloneGitWorkspace retries without hardlinks when local clone linking is blocked", () => {
  const calls: string[][] = [];

  cloneGitWorkspace({
    projectRoot: "/tmp/project",
    workspaceRoot: "/tmp/workspace",
    gitRunner: (args) => {
      calls.push(args);

      if (calls.length === 1) {
        const error = new Error("clone failed");
        (error as Error & { stderr?: string }).stderr =
          "fatal: failed to create link '/tmp/workspace/.git/objects/ab/cd': Operation not permitted";
        throw error;
      }

      return "";
    }
  });

  assert.deepEqual(calls, [
    ["clone", "--local", "/tmp/project", "/tmp/workspace"],
    ["clone", "--local", "--no-hardlinks", "/tmp/project", "/tmp/workspace"]
  ]);
});

test("cloneGitWorkspace does not swallow unrelated clone failures", () => {
  assert.throws(() =>
    cloneGitWorkspace({
      projectRoot: "/tmp/project",
      workspaceRoot: "/tmp/workspace",
      gitRunner: () => {
        throw new Error("fatal: repository '/tmp/project' does not exist");
      }
    })
  );
});

test("prepareSessionWorkspace builds an isolated git sandbox from the current tree", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agmo-session-workspace-"));

  try {
    runGit(["init", "-b", "main"], projectRoot);
    runGit(["config", "user.name", "Agmo Test"], projectRoot);
    runGit(["config", "user.email", "agmo@example.com"], projectRoot);

    await writeFile(join(projectRoot, "AGENTS.md"), "# Project Instructions\n", "utf-8");
    await writeFile(join(projectRoot, ".gitignore"), "node_modules\n", "utf-8");
    await mkdir(join(projectRoot, "packages", "demo"), { recursive: true });
    await writeFile(join(projectRoot, "packages", "demo", "index.ts"), "export const value = 1;\n", "utf-8");
    await writeFile(join(projectRoot, "tracked.txt"), "tracked-v1\n", "utf-8");
    runGit(["add", "."], projectRoot);
    runGit(["commit", "-m", "initial"], projectRoot);

    await writeFile(join(projectRoot, "tracked.txt"), "tracked-v2\n", "utf-8");
    await writeFile(join(projectRoot, "untracked.txt"), "draft\n", "utf-8");

    const workspace = await prepareSessionWorkspace({
      projectRoot,
      sessionId: "test-session"
    });

    const status = runGit(["status", "--short", "--branch"], workspace.workspaceRoot);
    assert.match(status, /## main/);
    assert.match(status, / M tracked\.txt/);
    assert.match(status, /\?\? untracked\.txt/);
    assert.doesNotMatch(status, /AGENTS\.md/);

    const workspaceAgents = await readFile(join(workspace.workspaceRoot, "AGENTS.md"), "utf-8");
    const sourceAgents = await readFile(join(projectRoot, "AGENTS.md"), "utf-8");
    assert.notEqual(workspaceAgents, sourceAgents);
    assert.equal(
      workspace.composedAgentsPath,
      join(
        resolveInstallPaths("project", projectRoot).sessionInstructionsDir,
        "test-session",
        "AGENTS.md"
      )
    );
    assert.equal(await readFile(workspace.composedAgentsPath, "utf-8"), workspaceAgents);
    const metadata = JSON.parse(await readFile(workspace.metadataPath, "utf-8")) as {
      composed_agents_path: string;
    };
    assert.equal(metadata.composed_agents_path, workspace.composedAgentsPath);

    await writeFile(join(workspace.workspaceRoot, "tracked.txt"), "workspace-only\n", "utf-8");
    const sourceTracked = await readFile(join(projectRoot, "tracked.txt"), "utf-8");
    assert.equal(sourceTracked, "tracked-v2\n");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("cleanupLaunchWorkspaces tolerates malformed historical session ids without escaping session cleanup", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agmo-session-workspace-cleanup-"));

  try {
    const paths = resolveInstallPaths("project", projectRoot);
    const workspaceDir = join(paths.cacheDir, "launch-workspaces", "bad-workspace");
    const workspaceRoot = join(workspaceDir, "workspace");
    const sentinel = join(paths.cacheDir, "outside-sentinel");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(workspaceRoot, "draft.txt"), "workspace\n", "utf-8");
    await writeFile(sentinel, "keep\n", "utf-8");
    await writeFile(
      join(workspaceDir, "metadata.json"),
      `${JSON.stringify(
        {
          session_id: "../outside-sentinel",
          project_root: projectRoot,
          workspace_root: workspaceRoot,
          composed_agents_path: join(paths.sessionInstructionsDir, "../outside-sentinel", "AGENTS.md"),
          created_at: "2026-01-01T00:00:00.000Z",
          active: false
        },
        null,
        2
      )}\n`,
      "utf-8"
    );

    const result = await cleanupLaunchWorkspaces({
      projectRoot,
      all: true
    });

    assert.deepEqual(result.removed, [
      {
        session_id: "bad-workspace",
        workspace_dir: workspaceDir,
        removed_session_agents: false
      }
    ]);
    assert.equal(result.kept.length, 0);
    assert.equal(await readFile(sentinel, "utf-8"), "keep\n");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
