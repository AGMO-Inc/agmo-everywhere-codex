import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { prepareSessionWorkspace } from "./session-workspace.js";

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

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

    await writeFile(join(workspace.workspaceRoot, "tracked.txt"), "workspace-only\n", "utf-8");
    const sourceTracked = await readFile(join(projectRoot, "tracked.txt"), "utf-8");
    assert.equal(sourceTracked, "tracked-v2\n");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
