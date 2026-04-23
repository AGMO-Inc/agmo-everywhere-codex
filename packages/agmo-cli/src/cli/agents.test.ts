import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncAgents } from "./agents.js";

test("syncAgents writes agmo-prefixed managed agents and removes renamed legacy managed files", async () => {
  const tempProject = await mkdtemp(join(os.tmpdir(), "agmo-agents-sync-"));
  const agentsDir = join(tempProject, ".codex", "agents");
  await mkdir(agentsDir, { recursive: true });

  await Promise.all([
    writeFile(join(agentsDir, "architect.toml"), 'name = "architect"\n', "utf-8"),
    writeFile(join(agentsDir, "critic.toml"), 'name = "critic"\n', "utf-8"),
    writeFile(join(agentsDir, "explore.toml"), 'name = "explore"\n', "utf-8"),
    writeFile(join(agentsDir, "custom-agent.toml"), 'name = "custom-agent"\n', "utf-8")
  ]);

  const result = await syncAgents("project", tempProject);

  assert.equal(result.count, 7);
  assert.deepEqual(result.removed_legacy_files, [
    join(agentsDir, "architect.toml"),
    join(agentsDir, "critic.toml"),
    join(agentsDir, "explore.toml")
  ]);

  assert.equal(existsSync(join(agentsDir, "agmo-architect.toml")), true);
  assert.equal(existsSync(join(agentsDir, "agmo-critic.toml")), true);
  assert.equal(existsSync(join(agentsDir, "agmo-explore.toml")), true);

  assert.equal(existsSync(join(agentsDir, "architect.toml")), false);
  assert.equal(existsSync(join(agentsDir, "critic.toml")), false);
  assert.equal(existsSync(join(agentsDir, "explore.toml")), false);

  assert.equal(existsSync(join(agentsDir, "custom-agent.toml")), true);
});
